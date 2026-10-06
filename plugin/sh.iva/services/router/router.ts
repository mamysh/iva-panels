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
      headers: filtered(req.headers),
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
export function createRouter(config: Config, engine: Pick<Engine, "handle">) {
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
      const parts: Buffer[] = [];
      let size = 0;
      for await (const part of req) {
        const bytes = Buffer.from(part);
        size += bytes.length;
        if (size > LIMITS.body) {
          res.writeHead(413);
          res.end();
          return;
        }
        parts.push(bytes);
      }
      const body = Buffer.concat(parts);
      let input: unknown;
      try {
        input = JSON.parse(body.toString());
      } catch {
        forward(req, res, config.upstream, body);
        return;
      }
      const raw = input as { message?: { text?: unknown } } | null;
      if (!owns(raw?.message?.text)) {
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
      const event = eventSchema.safeParse(input);
      if (
        !event.success ||
        !config.owners.includes(event.data.message.from.id)
      ) {
        res.writeHead(403);
        res.end();
        return;
      }
      await engine.handle(event.data);
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
