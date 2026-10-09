import { createHash, randomBytes } from "node:crypto";
import { request } from "node:http";
import { lstat, mkdir, open, rename, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  cardId,
  pluginKey,
  pluginName,
  smallJson,
  type PluginEntry,
} from "./catalog.ts";
import { render, type View } from "./contracts.ts";

const slug = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
const revision = z.number().int().min(0).max(999999999999);
const token = z.string().regex(/^[a-f0-9]{24}$/);
export const dynamicDefinitionSchema = z
  .object({
    schema: z.literal("iva-panels/v2"),
    plugin: pluginName,
    pluginVersion: z
      .string()
      .min(1)
      .max(48)
      .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/),
    entry: slug,
    capabilities: z
      .array(z.enum(["settings", "actions"]))
      .min(1)
      .max(2)
      .refine((v) => new Set(v).size === v.length),
  })
  .strict();
export type DynamicDefinition = z.infer<typeof dynamicDefinitionSchema>;
export function validateDynamicDefinition(
  value: unknown,
  name: string,
  version: string,
) {
  const definition = dynamicDefinitionSchema.parse(value);
  if (definition.plugin !== name || definition.pluginVersion !== version)
    throw new Error("PANEL_IDENTITY_MISMATCH");
  return definition;
}
export async function dynamicDefinition(
  data: string,
  p: PluginEntry,
  version?: string,
) {
  if (!p.enabled || !p.trusted || !version) return undefined;
  try {
    return validateDynamicDefinition(
      await smallJson(
        join(data, "custom/plugins", p.name, "panels.json"),
        32768,
      ),
      p.name,
      version,
    );
  } catch {
    return undefined;
  }
}
export const dynamicScreenSchema = z
  .object({
    state: z.literal("screen"),
    revision,
    title: z.string().min(1).max(80),
    body: z.string().max(1500),
    rows: z
      .array(
        z
          .array(
            z.union([
              z
                .object({ label: z.string().min(1).max(48), target: slug })
                .strict(),
              z
                .object({ label: z.string().min(1).max(48), action: slug })
                .strict(),
            ]),
          )
          .min(1)
          .max(2),
      )
      .max(5),
  })
  .strict();
const offerSchema = z
  .object({
    state: z.literal("offer"),
    token,
    revision,
    expiresAt: z.number().int().positive().safe(),
    summary: z.string().min(1).max(1500),
  })
  .strict();
const rejectedSchema = z
  .object({
    state: z.literal("rejected"),
    token,
    message: z.string().min(1).max(1500),
  })
  .strict();
const resultSchema = z
  .object({
    state: z.enum(["done", "cancelled"]),
    token,
    revision,
    message: z.string().min(1).max(1500),
  })
  .strict();
export type DynamicRequest =
  | { op: "read"; page: string }
  | { op: "prepare"; action: string; revision: number; token: string }
  | { op: "confirm" | "cancel" | "status"; token: string };
export type DynamicCall = (
  name: string,
  version: string,
  request: DynamicRequest,
) => Promise<unknown>;

// Fixed local socket, never a descriptor-selected URL, process, or MCP session.
export function socketCall(data: string): DynamicCall {
  return async (name, version, payload) => {
    pluginName.parse(name);
    const directory = resolve(data, "plugin-data", name);
    if ((await realpath(directory)) !== directory)
      throw new Error("PANEL_SOCKET_INVALID");
    const socket = join(directory, "panels.sock");
    const info = await lstat(socket);
    if (
      !info.isSocket() ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("PANEL_SOCKET_INVALID");
    const body = JSON.stringify({
      schema: "iva-panels/rpc-v1",
      plugin: name,
      pluginVersion: version,
      ...payload,
    });
    return new Promise((accept, reject) => {
      const req = request(
        {
          socketPath: socket,
          method: "POST",
          path: "/panels/v1",
          headers: {
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
          signal: AbortSignal.timeout(5000),
        },
        (res) => {
          let size = 0;
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > 32768) {
              res.destroy();
              reject(new Error("PANEL_RESPONSE_TOO_LARGE"));
            } else chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () => {
            try {
              if (res.statusCode !== 200)
                throw new Error("PANEL_REQUEST_FAILED");
              const envelope = z
                .object({
                  schema: z.literal("iva-panels/rpc-v1"),
                  plugin: z.literal(name),
                  pluginVersion: z.literal(version),
                  result: z.unknown(),
                })
                .strict()
                .parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
              accept(envelope.result);
            } catch {
              reject(new Error("PANEL_RESPONSE_INVALID"));
            }
          });
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  };
}
const jobSchema = z
  .object({
    schema: z.literal(1),
    plugin: pluginName,
    pluginVersion: z.string(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    token,
    revision,
    expiresAt: z.number().int().nonnegative().safe(),
    summary: z.string().max(1500),
    phase: z.enum([
      "preparing",
      "offered",
      "confirming",
      "cancelling",
      "uncertain",
      "done",
      "cancelled",
      "rejected",
    ]),
    result: resultSchema.optional(),
  })
  .strict();
type Job = z.infer<typeof jobSchema>;
const jobsSchema = z.record(z.string().regex(/^[a-f0-9]{24}$/), jobSchema);
export const dynamicReadId = (name: string, page: string) =>
  `dyn:read:${pluginKey(name)}:${page}`;
export const isDynamicMutation = (id: string) =>
  /^dyn:(prepare|confirm|cancel):/.test(id);
export class DynamicPanels {
  readonly data: string;
  readonly directory: string;
  readonly call: DynamicCall;
  readonly now: () => number;
  constructor(
    data: string,
    directory: string,
    call: DynamicCall = socketCall(data),
    now = Date.now,
  ) {
    this.data = data;
    this.directory = directory;
    this.call = call;
    this.now = now;
  }
  private async load() {
    try {
      return jobsSchema.parse(
        await smallJson(
          join(this.directory, "dynamic-jobs.json"),
          5 * 1024 * 1024,
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private async save(jobs: Record<string, Job>) {
    jobsSchema.parse(jobs);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = join(
      this.directory,
      `.dynamic-${randomBytes(8).toString("hex")}.tmp`,
    );
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(jobs));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, join(this.directory, "dynamic-jobs.json"));
    const dir = await open(this.directory, "r");
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  }
  private fingerprint(p: PluginEntry, d: DynamicDefinition) {
    return createHash("sha256")
      .update(JSON.stringify([p, d]))
      .digest("hex");
  }
  private view(p: PluginEntry, d: DynamicDefinition, value: unknown): View {
    const screen = dynamicScreenSchema.parse(value);
    const view = {
      title: screen.title,
      body: screen.body,
      rows: [
        ...screen.rows.map((row) =>
          row.map((b) => ({
            label: b.label,
            id:
              "target" in b
                ? dynamicReadId(p.name, b.target)
                : `dyn:prepare:${pluginKey(p.name)}:${screen.revision}:${b.action}`,
          })),
        ),
        ...(screen.rows
          .flat()
          .some((button) => "target" in button && button.target === d.entry)
          ? []
          : [
              [
                {
                  id: dynamicReadId(p.name, d.entry),
                  label: "Обновить раздел",
                },
              ],
            ]),
        [
          { id: cardId(p.name), label: "О плагине" },
          { id: "close", label: "Закрыть" },
        ],
      ],
    };
    render(view, "0".repeat(24), 0);
    return view;
  }
  private notice(p: PluginEntry, body: string, pending?: string): View {
    return {
      title: `${p.name} · Панель`,
      body,
      rows: [
        ...(pending
          ? [
              [
                {
                  id: `dyn:status:${pluginKey(p.name)}:${pending}`,
                  label: "Проверить результат",
                },
              ],
            ]
          : []),
        [
          { id: cardId(p.name), label: "О плагине" },
          { id: "close", label: "Закрыть" },
        ],
      ],
    };
  }
  async recover(p: PluginEntry): Promise<View> {
    const jobs = await this.load();
    const job = jobs[pluginKey(p.name)];
    return this.notice(
      p,
      "Запрос прерван. Повторного действия не выполнялось. Проверьте результат у плагина.",
      job?.token,
    );
  }
  async page(id: string, p: PluginEntry, d: DynamicDefinition): Promise<View> {
    const parts = id.split(":");
    if (parts[0] !== "dyn" || parts[2] !== pluginKey(p.name))
      throw new Error("PANEL_ACTION_INVALID");
    const op = parts[1];
    const key = pluginKey(p.name);
    if (op === "read" && parts.length === 4) {
      slug.parse(parts[3]);
      try {
        const jobs = await this.load();
        const job = jobs[key];
        if (
          job &&
          ["preparing", "confirming", "cancelling", "uncertain"].includes(
            job.phase,
          )
        )
          return this.notice(
            p,
            "Предыдущий запрос не завершён. Новое действие заблокировано до проверки результата.",
            job.token,
          );
        return this.view(
          p,
          d,
          await this.call(p.name, d.pluginVersion, {
            op: "read",
            page: parts[3],
          }),
        );
      } catch {
        return this.notice(
          p,
          "API плагина недоступен или вернул несовместимый ответ. Регистрация и настройки не изменены.",
        );
      }
    }
    const jobs = await this.load();
    const previous = jobs[key];
    if (op === "prepare" && parts.length === 5) {
      if (!/^(0|[1-9]\d{0,11})$/.test(parts[3]))
        throw new Error("PANEL_ACTION_INVALID");
      const rev = revision.parse(Number(parts[3]));
      const action = slug.parse(parts[4]);
      if (
        previous &&
        ["preparing", "confirming", "cancelling", "uncertain"].includes(
          previous.phase,
        )
      )
        return this.notice(
          p,
          "Предыдущий запрос требует проверки. Новое предложение не создано.",
          previous.token,
        );
      // One offer at a time; do not silently invalidate a preview in another screen.
      if (previous?.phase === "offered" && previous.expiresAt > this.now())
        return this.notice(
          p,
          "Уже есть предложение. Подтвердите или отмените его в исходном экране, либо дождитесь истечения срока.",
        );
      const job: Job = {
        schema: 1,
        plugin: p.name,
        pluginVersion: d.pluginVersion,
        fingerprint: this.fingerprint(p, d),
        token: randomBytes(12).toString("hex"),
        revision: rev,
        expiresAt: 0,
        summary: "",
        phase: "preparing",
      };
      jobs[key] = job;
      await this.save(jobs);
      try {
        const response = await this.call(p.name, d.pluginVersion, {
          op: "prepare",
          action,
          revision: rev,
          token: job.token,
        });
        if ((response as { state?: string })?.state === "rejected") {
          const rejected = rejectedSchema.parse(response);
          if (rejected.token !== job.token)
            throw new Error("PANEL_RESULT_INVALID");
          job.phase = "rejected";
          await this.save(jobs);
          return this.notice(p, rejected.message);
        }
        const offer = offerSchema.parse(response);
        if (
          offer.token !== job.token ||
          offer.revision !== rev ||
          offer.expiresAt <= this.now() ||
          offer.expiresAt > this.now() + 15 * 60_000
        )
          throw new Error("PANEL_OFFER_INVALID");
        job.expiresAt = offer.expiresAt;
        job.summary = offer.summary;
        job.phase = "offered";
        const view = {
          title: `${p.name} · Подтверждение`,
          body: offer.summary,
          rows: [
            [
              { id: `dyn:confirm:${key}:${job.token}`, label: "Подтвердить" },
              { id: `dyn:cancel:${key}:${job.token}`, label: "Отменить" },
            ],
          ],
        };
        render(view, "0".repeat(24), 0);
        await this.save(jobs);
        return view;
      } catch {
        job.phase = "uncertain";
        await this.save(jobs);
        return this.recover(p);
      }
    }
    if (!["confirm", "cancel", "status"].includes(op) || parts.length !== 4)
      throw new Error("PANEL_ACTION_INVALID");
    token.parse(parts[3]);
    const job = jobs[key];
    if (!job || job.token !== parts[3])
      return this.notice(p, "Предложение устарело. Откройте настройки заново.");
    if (job.fingerprint !== this.fingerprint(p, d))
      return this.notice(
        p,
        "Плагин или его регистрация изменились. Старое предложение не выполняется; проверьте его результат у плагина.",
      );
    if (job.result) return this.notice(p, job.result.message);
    if (op !== "status") {
      if (job.phase !== "offered") return this.recover(p);
      if (op === "confirm" && job.expiresAt <= this.now())
        return this.notice(
          p,
          "Срок предложения истёк. Откройте настройки заново.",
        );
      job.phase = op === "confirm" ? "confirming" : "cancelling";
      await this.save(jobs); // Persist intent before plugin-owned effect; never retry it.
    }
    try {
      const value = await this.call(p.name, d.pluginVersion, {
        op: op as "confirm" | "cancel" | "status",
        token: job.token,
      });
      // status may return an outstanding offer; it is not permission to replay confirm.
      if (op === "status" && (value as { state?: string })?.state === "offer")
        return this.notice(
          p,
          "Плагин ещё хранит предложение. Если запрос был прерван, проверьте его у плагина; автоматического повторения нет.",
          job.token,
        );
      const result = resultSchema.parse(value);
      if (
        result.token !== job.token ||
        result.revision !== job.revision + (result.state === "done" ? 1 : 0) ||
        (op === "confirm" && result.state !== "done") ||
        (op === "cancel" && result.state !== "cancelled")
      )
        throw new Error("PANEL_RESULT_INVALID");
      job.phase = result.state;
      job.result = result;
      await this.save(jobs);
      return this.notice(p, result.message);
    } catch {
      if (op !== "status") {
        job.phase = "uncertain";
        await this.save(jobs);
      }
      return this.recover(p);
    }
  }
}
