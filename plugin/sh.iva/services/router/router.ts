import {
  createServer,
  request as upstreamRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import {
  ACCEPTANCE,
  LIMITS,
  owns,
  eventSchema,
  type Config,
} from "./contracts.ts";
import type { Engine } from "./engine.ts";
const ingress = new Set(["/eve/v1/telegram", "/eve/v1/telegram/accepted"]);
const hop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);
function filtered(headers: IncomingMessage["headers"]) {
  const blocked = new Set([
    ...hop,
    ...String(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((s) => s.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !blocked.has(key)),
  );
}
function authenticated(value: unknown, secret: string) {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
function forward(
  req: IncomingMessage,
  res: ServerResponse,
  origin: string,
  body?: Buffer,
) {
  const address = new URL(origin); // Incoming //path never selects another authority.
  const upstream = upstreamRequest(
    {
      hostname: address.hostname,
      port: address.port,
      method: req.method,
      path: req.url,
      headers: {
        ...filtered(req.headers),
        ...(body ? { "content-length": String(body.length) } : {}),
      },
    },
    (result) => {
      res.writeHead(result.statusCode ?? 502, filtered(result.headers));
      result.on("error", () => res.destroy());
      result.pipe(res);
    },
  );
  upstream.setTimeout(105_000, () => upstream.destroy(new Error("TIMEOUT")));
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  });
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => {
    if (!res.writableFinished) upstream.destroy();
  });
  if (body) upstream.end(body);
  else req.pipe(upstream);
}
export function createRouter(
  config: Config,
  engine: Pick<Engine, "handle">,
  acknowledge: (id: string) => Promise<void> = async () => {},
) {
  return createServer(async (req, res) => {
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, mode: config.mode }));
      return;
    }
    if (
      config.mode === "passthrough" ||
      req.method !== "POST" ||
      !ingress.has(req.url ?? "")
    ) {
      forward(req, res, config.upstream);
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        if (size > LIMITS.body) {
          res.writeHead(413);
          res.end();
          return;
        }
        chunks.push(bytes);
      }
      const body = Buffer.concat(chunks);
      let input: unknown;
      try {
        input = JSON.parse(body.toString());
      } catch {
        forward(req, res, config.upstream, body);
        return;
      }
      // iva_* callbacks pass stock Bridge unchanged. Normalize only our own
      // envelope; ownership, private chat, message and revision are still checked.
      const callback = (input as { callback_query?: unknown } | null)
        ?.callback_query;
      let callbackId: string | undefined;
      if (callback && typeof callback === "object") {
        const tap = callback as {
          id?: unknown;
          data?: unknown;
          from?: unknown;
          message?: Record<string, unknown>;
        };
        if (
          typeof tap.data === "string" &&
          tap.data.startsWith("iva_panels:")
        ) {
          if (
            typeof tap.id !== "string" ||
            tap.id.length === 0 ||
            tap.id.length > 256 ||
            !tap.message ||
            typeof tap.message !== "object"
          ) {
            res.writeHead(403);
            res.end();
            return;
          }
          callbackId = tap.id;
          input = {
            ...(input as Record<string, unknown>),
            message: {
              message_id: tap.message.message_id,
              chat: tap.message.chat,
              from: tap.from,
              text: tap.data,
            },
          };
        }
      }
      const raw = input as {
        message?: {
          text?: unknown;
          iva_parts?: unknown;
          iva_durable_queue_receipt?: unknown;
        };
      } | null;
      const batch = Array.isArray(raw?.message?.iva_parts)
        ? raw.message.iva_parts
        : null;
      const parts = batch ?? [raw?.message];
      const own = parts
        .map((message, index) => ({ message, index }))
        .filter((p) => owns(p.message?.text));
      if (own.length === 0) {
        forward(req, res, config.upstream, body);
        return;
      }
      if (
        !authenticated(
          req.headers["x-telegram-bot-api-secret-token"],
          config.secret,
        )
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      const events = own.map((p) => ({
        index: p.index,
        event: eventSchema.safeParse({ ...raw, message: p.message }),
      }));
      if (
        (batch && (batch.length === 0 || batch.length > 20)) ||
        events.some(
          (p) =>
            !p.event.success ||
            !config.owners.includes(p.event.data.message.from.id),
        )
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      for (const part of events) {
        if (!part.event.success) throw new Error("INVALID_PART");
        await engine.handle(part.event.data, batch ? part.index : undefined);
      }
      if (callbackId) await acknowledge(callbackId).catch(() => {});
      const ordinary = parts.filter((message) => !owns(message?.text));
      if (batch && ordinary.length > 0) {
        // Keep the upstream queue receipt and maximum update ID, but only ordinary
        // messages may reach Eve. A downstream turn receipt owns the whole batch.
        const message = { ...ordinary[0] };
        if (raw?.message?.iva_durable_queue_receipt !== undefined)
          message.iva_durable_queue_receipt =
            raw.message.iva_durable_queue_receipt;
        delete message.iva_parts;
        if (ordinary.length > 1) message.iva_parts = ordinary;
        forward(
          req,
          res,
          config.upstream,
          Buffer.from(JSON.stringify({ ...raw, message })),
        );
        return;
      }
      res.writeHead(req.url?.endsWith("/accepted") ? 204 : 200, {
        [ACCEPTANCE]: "handled",
      });
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(503);
      res.end();
    }
  });
}
