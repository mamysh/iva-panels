import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, rename, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { z } from "zod";
import {
  smallJson,
  entrySchema,
  pluginKey,
  cardId,
  type PluginEntry,
} from "./catalog.ts";
import type { View } from "./contracts.ts";
export const lifecycleConfig = z
  .object({
    cli: z
      .string()
      .min(1)
      .max(512)
      .regex(/^\/[^\0]*\/iva\.mjs$/),
  })
  .strict();
export const jobSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().uuid(),
    name: entrySchema.shape.name,
    target: z.boolean(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    registryFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    issue: z
      .enum([
        "registry_changed",
        "services_failed",
        "artifacts_missing",
        "manager_failed",
        "unsupported_manager",
        "preflight_failed",
      ])
      .optional(),
    created: z.number().finite(),
    expires: z.number().finite(),
    cli: z.string(),
    affected: z.array(entrySchema.shape.name).max(10).optional(),
    submitted: z.number().finite().optional(),
    started: z.number().finite().optional(),
    completed: z.number().finite().optional(),
    phase: z.enum([
      "preview",
      "cancelled",
      "queued",
      "running",
      "done",
      "failed",
      "uncertain",
    ]),
  })
  .strict();
export type Job = z.infer<typeof jobSchema>;
export type Launch = (id: string) => Promise<void>;
const token = /^life:(confirm|cancel|status):([a-f0-9-]{36})$/;
export function isLifecycleMutation(id: string) {
  return (
    /^life:prepare:[a-f0-9]{24}:(enable|disable)$/.test(id) ||
    /^life:(confirm|cancel):[a-f0-9-]{36}$/.test(id)
  );
}
export function installationPin(entry: PluginEntry): string | undefined {
  if (/^[a-f0-9]{40}$/.test(entry.sha ?? "")) return entry.sha;
  if (typeof entry.digest === "string" && /^[a-f0-9]{64}$/.test(entry.digest))
    return entry.digest;
}
export function fingerprint(entry: PluginEntry) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        entry.name,
        entry.enabled,
        entry.trusted,
        entry.sha,
        entry.ref,
        entry.version,
        entry.digest,
        entry.source,
        entry.mcp,
        entry.services,
      ]),
    )
    .digest("hex");
}
export function registryFingerprint(entries: PluginEntry[]) {
  return createHash("sha256")
    .update(
      JSON.stringify(
        entries
          .map((e) => [e.name, fingerprint(e)])
          .sort((a, b) => a[0].localeCompare(b[0])),
      ),
    )
    .digest("hex");
}
export async function registered(data: string) {
  return z
    .object({ plugins: z.array(entrySchema).max(1000) })
    .refine(
      (r) => new Set(r.plugins.map((p) => p.name)).size === r.plugins.length,
    )
    .parse(await smallJson(join(data, "custom/plugins.json"), 5 * 1024 * 1024))
    .plugins;
}
export async function saveJob(dir: string, job: Job) {
  jobSchema.parse(job);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `.job-${randomUUID()}.tmp`),
    file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(job));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(path, join(dir, job.id + ".json"));
  const folder = await open(dir, "r");
  try {
    await folder.sync();
  } finally {
    await folder.close();
  }
}
export async function readJob(dir: string, id: string) {
  z.string().uuid().parse(id);
  return jobSchema.parse(await smallJson(join(dir, id + ".json"), 8192));
}
function safeEnv() {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "PATH",
    "USER",
    "LOGNAME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "LANG",
  ])
    if (process.env[key]) env[key] = process.env[key];
  return env;
}
export function systemdLaunch(data: string, panels: string): Launch {
  return async (id) => {
    z.string().uuid().parse(id);
    const worker = fileURLToPath(
      new URL("./lifecycle-worker.mjs", import.meta.url),
    );
    await new Promise<void>((resolve, reject) =>
      execFile(
        "systemd-run",
        [
          "--user",
          "--collect",
          "--unit=iva-panels-lifecycle",
          "--property=Type=exec",
          "--property=Restart=no",
          "--property=RuntimeMaxSec=900",
          "--",
          process.execPath,
          worker,
          data,
          panels,
          id,
        ],
        { env: safeEnv(), timeout: 10_000, maxBuffer: 8192 },
        (error) =>
          error ? reject(new Error("LIFECYCLE_LAUNCH_UNCERTAIN")) : resolve(),
      ),
    );
  };
}
export class Lifecycle {
  dir: string;
  data: string;
  panels: string;
  config: z.infer<typeof lifecycleConfig>;
  launch: Launch;
  now: () => number;
  constructor(
    data: string,
    panels: string,
    config: z.infer<typeof lifecycleConfig>,
    launch: Launch = systemdLaunch(data, panels),
    now = Date.now,
  ) {
    this.data = data;
    this.panels = panels;
    this.config = config;
    this.launch = launch;
    this.now = now;
    this.dir = join(panels, "lifecycle");
  }
  async busy() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const names = (await readdir(this.dir)).filter((n) =>
      /^[a-f0-9-]{36}\.json$/.test(n),
    );
    if (names.length >= 100) throw new Error("LIFECYCLE_CAPACITY");
    for (const name of names) {
      const j = await readJob(this.dir, name.slice(0, -5));
      if (["queued", "running", "uncertain"].includes(j.phase)) return true;
    }
    return false;
  }
  async latest(name: string) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.dir)).filter((n) =>
      /^[a-f0-9-]{36}\.json$/.test(n),
    );
    if (files.length > 100) throw new Error("LIFECYCLE_CAPACITY");
    const jobs = [];
    for (const file of files) {
      const job = await readJob(this.dir, file.slice(0, -5));
      if (job.name === name && job.phase !== "preview") jobs.push(job);
    }
    return jobs.sort((a, b) => b.created - a.created)[0];
  }
  status(job: Job): View {
    const messages: Record<Job["phase"], string> = {
      preview: "Изменение ещё не подтверждено.",
      cancelled: "Отменено. Команда менеджеру не отправлялась.",
      queued:
        "Передача отдельной задаче сохранена. Проверьте результат; при сбое запуска команда автоматически не повторяется.",
      running:
        "Штатный менеджер выполняет команду. Ива может ненадолго перезапуститься.",
      done: job.registryFingerprint
        ? "Изменение завершено. Проверены весь список плагинов, службы, файлы сборки и доступность Ивы."
        : "Задача завершена прежней версией Panels. Полная проверка соседних плагинов тогда не выполнялась.",
      failed:
        "Команда не выполнена: состояние или предложение изменилось. Проверьте карточку перед новым выбором.",
      uncertain:
        "Результат полностью не подтверждён. Команда автоматически не повторяется; проверьте регистрацию, службы и версию Ивы.",
    };
    const issues: Record<NonNullable<Job["issue"]>, string> = {
      registry_changed:
        "Менеджер изменил другой плагин или его регистрацию. Управление остановлено до проверки оператора. Автоматического отката не было.",
      services_failed:
        "Одна из служб плагинов или юзербот не прошла проверку. Дальнейшее управление остановлено до проверки оператора.",
      artifacts_missing:
        "В текущей сборке отсутствуют необходимые файлы плагинов. Дальнейшее управление остановлено до проверки оператора.",
      manager_failed: "Менеджер не подтвердил успешное завершение команды.",
      unsupported_manager:
        "Эта версия менеджера Ивы не поддержана. Команда не запускалась; ядро не изменялось.",
      preflight_failed:
        "Проверка перед запуском не прошла. Команда не выполнялась; проверьте состояние плагинов и служб.",
    };
    const overdue =
      ["queued", "running"].includes(job.phase) &&
      this.now() - (job.started ?? job.submitted ?? job.created) > 16 * 60_000;
    return {
      title: `Управление · ${job.name}`,
      body: `${job.target ? "Включение" : "Выключение"} плагина\n\n${job.issue ? issues[job.issue] + (job.affected?.length ? " Плагины: " + job.affected.join(", ") : "") + "\n\n" : ""}${overdue ? "Задача не завершилась в ожидаемый срок. Нужна проверка оператора; команда не повторяется." : messages[job.phase]}`,
      rows: [
        [{ id: `life:status:${job.id}`, label: "Проверить результат" }],
        [
          { id: cardId(job.name), label: "О плагине" },
          { id: "close", label: "Закрыть" },
        ],
      ],
    };
  }
  async recover(id: string): Promise<View> {
    const m = token.exec(id);
    if (m) {
      try {
        return this.status(await readJob(this.dir, m[2]));
      } catch {}
    }
    return {
      title: "Управление плагином",
      body: "Запрос прервался. Команда автоматически не повторялась. Проверьте состояние плагина перед новым выбором.",
      rows: [
        [
          { id: "home", label: "К плагинам" },
          { id: "close", label: "Закрыть" },
        ],
      ],
    };
  }
  async page(id: string): Promise<View> {
    const m = token.exec(id);
    if (m) {
      let job = await readJob(this.dir, m[2]);
      if (m[1] === "status" || job.phase !== "preview") return this.status(job);
      if (m[1] === "cancel") {
        job.phase = "cancelled";
        await saveJob(this.dir, job);
        return this.status(job);
      }
      const entries = await registered(this.data),
        entry = entries.find((e) => e.name === job.name);
      if (
        this.now() > job.expires ||
        job.cli !== this.config.cli ||
        !entry ||
        fingerprint(entry) !== job.fingerprint ||
        !job.registryFingerprint ||
        registryFingerprint(await registered(this.data)) !==
          job.registryFingerprint ||
        !entry.trusted ||
        entry.name === "iva-panels"
      ) {
        job.phase = "failed";
        await saveJob(this.dir, job);
        return this.status(job);
      }
      if (await this.busy())
        return {
          title: "Управление занято",
          body: "Предыдущая задача требует завершения или проверки оператора. Проверьте её результат; новое действие не запускалось.",
          rows: [
            [
              { id: cardId(job.name), label: "О плагине" },
              { id: "close", label: "Закрыть" },
            ],
          ],
        };
      job.phase = "queued";
      job.submitted = this.now();
      await saveJob(this.dir, job);
      try {
        await this.launch(job.id);
      } catch {
        job = await readJob(this.dir, job.id);
        if (job.phase === "queued") {
          job.phase = "uncertain";
          await saveJob(this.dir, job);
        }
      }
      return this.status(await readJob(this.dir, job.id));
    }
    const action =
      /^life:(open|prepare):([a-f0-9]{24})(?::(enable|disable))?$/.exec(id);
    if (!action || (action[1] === "open") === Boolean(action[3]))
      throw new Error("LIFECYCLE_INVALID");
    const entry = (await registered(this.data)).find(
      (e) => pluginKey(e.name) === action[2],
    );
    if (!entry) throw new Error("PLUGIN_UNAVAILABLE");
    const rows = [
      [
        { id: cardId(entry.name), label: "О плагине" },
        { id: "close", label: "Закрыть" },
      ],
    ];
    if (
      entry.name === "iva-panels" ||
      !entry.trusted ||
      !installationPin(entry)
    )
      return {
        title: `Управление · ${entry.name}`,
        body:
          entry.name === "iva-panels"
            ? "Самостоятельное выключение Panels заблокировано: сначала требуется вернуть исходный маршрут Bridge."
            : "Для управления нужны прежнее доверие и закреплённая версия установки. Доверие через Panels не повышается.",
        rows,
      };
    if (action[1] === "open") {
      const latest = await this.latest(entry.name);
      return {
        title: `Управление · ${entry.name}`,
        body: `Сейчас: ${entry.enabled ? "включён" : "выключен"}\n\nБудет выполнена полная штатная сборка той же версии Ивы без изменения её исходников. Возможен короткий перезапуск. Выбор сначала покажет подтверждение. Файлы и настройки плагина не удаляются.`,
        rows: [
          [
            {
              id: `life:prepare:${action[2]}:${entry.enabled ? "disable" : "enable"}`,
              label: entry.enabled ? "Выключить плагин" : "Включить плагин",
            },
          ],
          ...(latest
            ? [[{ id: `life:status:${latest.id}`, label: "Последняя задача" }]]
            : []),
          ...rows,
        ],
      };
    }
    const target = action[3] === "enable";
    if (target === entry.enabled) return this.page(`life:open:${action[2]}`);
    if (await this.busy())
      return {
        title: "Управление занято",
        body: "Предыдущая задача требует завершения или проверки оператора. Новый выбор не подготовлен.",
        rows,
      };
    const now = this.now(),
      job: Job = {
        schema: 1,
        id: randomUUID(),
        name: entry.name,
        target,
        fingerprint: fingerprint(entry),
        registryFingerprint: registryFingerprint(await registered(this.data)),
        created: now,
        expires: now + 15 * 60_000,
        cli: this.config.cli,
        phase: "preview",
      };
    await saveJob(this.dir, job);
    return {
      title: `Подтверждение · ${entry.name}`,
      body: `Сейчас: ${entry.enabled ? "включён" : "выключен"}\nПосле подтверждения: ${target ? "включён" : "выключен"}\nВерсия установки: ${installationPin(entry)!.slice(0, 12)}\n\nШтатный менеджер выполнит полную сборку той же версии Ивы. Исходники ядра не меняются. Это может занять несколько минут; возможен короткий перезапуск. Файлы и настройки не удаляются. Предложение действует 15 минут.`,
      rows: [
        [
          { id: `life:confirm:${job.id}`, label: "Подтвердить" },
          { id: `life:cancel:${job.id}`, label: "Отменить" },
        ],
      ],
    };
  }
}
