import { readFile, stat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  DEFAULT_INHERITED_ENV_VARS,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { VERSION, type View } from "./contracts.ts";

const sections = [
  "home",
  "connection",
  "capabilities",
  "actions",
  "privacy",
] as const;
export type BitrixSection = (typeof sections)[number];
export type BitrixRead = (section: BitrixSection) => Promise<unknown>;
export type BitrixChange = (reply: string) => Promise<unknown>;
export const choiceSchema = z.enum([
  "read",
  "write",
  "upload_on",
  "upload_off",
  "delete_on",
  "delete_off",
  "ids",
  "names",
  "work",
  "email_on",
  "email_off",
]);
const changeId = z.union([
  z
    .string()
    .regex(
      /^bitrix:set:(0|[1-9]\d{0,15}):(read|write|upload_on|upload_off|delete_on|delete_off|ids|names|work|email_on|email_off)$/,
    ),
  z.string().regex(/^bitrix:(confirm|cancel):[a-f0-9-]{36}:(0|[1-9]\d{0,15})$/),
]);
export function isBitrixChange(id: string) {
  return changeId.safeParse(id).success;
}
class BitrixError extends Error {
  code: string;
  constructor(code: string) {
    super("BITRIX_REQUEST_FAILED");
    this.code = code;
  }
}
const policy = z
  .object({
    mode: z.enum(["read_only", "confirmed_write"]),
    uploads: z.boolean(),
    deletions: z.boolean(),
    people: z.enum(["ids", "names", "work"]),
    email: z.boolean(),
  })
  .strict()
  .refine((p) => !p.email || p.people === "work");
const settings = z.object({
  schema: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  policy,
});

// Own short-lived stdio session: never initialize the single-session Eve proxy.
function bitrixCall(data: string) {
  return async (tool: string, args: Record<string, unknown>) => {
    const root = join(data, "custom", "plugins", "bitrix24-read");
    const manifest = JSON.parse(
      await readFile(join(root, "plugin.json"), "utf8"),
    );
    if (
      manifest.name !== "bitrix24-read" ||
      !["0.9.0-rc.1", "0.9.0-rc.2"].includes(manifest.version)
    )
      throw new Error("BITRIX_VERSION_UNSUPPORTED");
    const path = join(data, "custom", "plugins", "bitrix24-read.env");
    let values: Record<string, string | undefined> = {};
    try {
      const info = await stat(path);
      if (!info.isFile() || info.size > 16384 || info.mode & 0o077)
        throw new Error("PRIVATE_ENV_REQUIRED");
      values = parseEnv(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const env: Record<string, string | undefined> = {};
    for (const key of DEFAULT_INHERITED_ENV_VARS) env[key] = undefined;
    for (const key of [
      "BITRIX24_WEBHOOK_BASE_URL",
      "BITRIX24_SETTINGS_DEFAULTS",
    ])
      if (values[key] !== undefined) env[key] = values[key];
    env.PLUGIN_ROOT = root;
    env.PLUGIN_DATA = join(data, "plugin-data", "bitrix24-read");
    const transport = new StdioClientTransport({
      command: process.execPath,
      // SDK merges a default env. Undefined masks those keys before Node spawn.
      args: [await realpath(join(root, "server.mjs"))],
      cwd: root,
      env: env as Record<string, string>,
      stderr: "ignore",
      maxBufferSize: 256 * 1024,
    });
    const client = new Client({
      name: "iva-panels-settings",
      version: VERSION,
    });
    const signal = AbortSignal.timeout(15_000);
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
      const result = await client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal, timeout: 15_000 },
      );
      const content = result.content as Array<{ type: string; text?: string }>;
      if (
        content.length !== 1 ||
        content[0].type !== "text" ||
        !content[0].text ||
        content[0].text.length > 65536
      )
        throw new Error("BITRIX_RESPONSE_INVALID");
      const value = JSON.parse(content[0].text);
      if (result.isError)
        throw new BitrixError(
          [
            "SETTINGS_CHANGED",
            "SETTINGS_OFFER_INVALID",
            "WRITE_BUSY",
            "EMAIL_REQUIRES_WORK_PROFILE",
          ].includes(value?.error)
            ? value.error
            : "UNKNOWN",
        );
      return value;
    } finally {
      await client.close();
    }
  };
}
export function bitrixReader(data: string): BitrixRead {
  const call = bitrixCall(data);
  return (section) =>
    call(
      section === "connection"
        ? "bitrix24_connection_check"
        : section === "capabilities"
          ? "bitrix24_capabilities"
          : "bitrix24_settings",
      section === "connection" || section === "capabilities"
        ? {}
        : { screen: section === "privacy" ? "privacy" : "actions" },
    );
}
export function bitrixChanger(data: string): BitrixChange {
  const call = bitrixCall(data);
  return (reply) => {
    if (
      !/^b24s:set:(0|[1-9]\d{0,15}):(read|write|upload_on|upload_off|delete_on|delete_off|ids|names|work|email_on|email_off)$/.test(
        reply,
      ) &&
      !/^b24s:(confirm|cancel):[a-f0-9-]{36}$/.test(reply)
    )
      throw new Error("INVALID_SETTINGS_ACTION");
    if (reply.startsWith("b24s:confirm:") || reply.startsWith("b24s:cancel:"))
      z.uuid().parse(reply.split(":")[2]);
    return call("bitrix24_settings", { reply });
  };
}

export async function bitrixPage(
  section: string,
  read: BitrixRead,
  editable = false,
): Promise<View> {
  if (!sections.includes(section as BitrixSection))
    throw new Error("UNKNOWN_BITRIX_PAGE");
  const page = section as BitrixSection;
  const titles: Record<BitrixSection, string> = {
    home: "Bitrix24 · Настройки",
    connection: "Bitrix24 · Подключение",
    capabilities: "Bitrix24 · Права webhook",
    actions: "Bitrix24 · Действия",
    privacy: "Bitrix24 · Данные сотрудников",
  };
  const id = (s: BitrixSection) =>
    s === "home" ? "bitrix24-read" : `bitrix:${s}`;
  const rows =
    page === "home"
      ? [
          [
            { id: id("connection"), label: "Подключение" },
            { id: id("capabilities"), label: "Права webhook" },
          ],
          [
            { id: id("actions"), label: "Действия" },
            { id: id("privacy"), label: "Данные" },
          ],
          [{ id: id(page), label: "Обновить сведения" }],
          [
            { id: "home", label: "К плагинам" },
            { id: "close", label: "Закрыть" },
          ],
        ]
      : [
          [{ id: id(page), label: "Проверить снова" }],
          [
            { id: id("home"), label: "Настройки Bitrix24" },
            { id: "close", label: "Закрыть" },
          ],
        ];
  let body: string;
  try {
    const raw = await read(page);
    const checked = `Проверено: ${new Date()
      .toISOString()
      .replace("T", " ")
      .replace(/\.\d+Z$/, " UTC")}`;
    if (page === "connection") {
      z.object({
        connected: z.literal(true),
        taskScope: z.literal(true),
        taskContentChecked: z.literal(false),
        contractVersion: z.literal("0.4"),
      }).parse(raw);
      body = `Соединение работает. Доступ к методам задач проверен.\n\nСодержимое задач и документов не запрашивалось.\n\n${checked}`;
    } else if (page === "capabilities") {
      const { grantedScopes } = z
        .object({
          contractVersion: z.literal("0.4"),
          grantedScopes: z.array(z.string().max(64)).max(32),
        })
        .parse(raw);
      const scopes = new Set(grantedScopes);
      const people = ["user_brief", "user_basic", "user"].some((s) =>
        scopes.has(s),
      );
      const features: Array<[string, boolean]> = [
        ["Задачи", scopes.has("task")],
        ["Обсуждения", scopes.has("task") && scopes.has("im")],
        ["Проекты", scopes.has("sonet_group")],
        ["Сотрудники", people],
        ["Подразделения", scopes.has("department")],
        ["Вложения задач", scopes.has("task") && scopes.has("disk")],
      ];
      body =
        features
          .map(
            ([label, yes]) => `${label}: ${yes ? "право есть" : "права нет"}`,
          )
          .join("\n") +
        `\n\nПрава webhook не гарантируют доступ ко всем объектам и возможность записи.\n\n${checked}`;
    } else {
      const parsed = z
        .object({ state: z.literal("screen"), settings })
        .parse(raw).settings;
      const p = parsed.policy;
      if (editable && (page === "actions" || page === "privacy")) {
        const select = (
          label: string,
          choice: z.infer<typeof choiceSchema>,
        ) => ({ id: `bitrix:set:${parsed.revision}:${choice}`, label });
        const options =
          page === "actions"
            ? [
                [
                  select(
                    `${p.mode === "read_only" ? "✓ " : ""}Только чтение`,
                    "read",
                  ),
                  select(
                    `${p.mode === "confirmed_write" ? "✓ " : ""}Запись`,
                    "write",
                  ),
                ],
                [
                  select(
                    p.uploads ? "Выключить загрузку" : "Включить загрузку",
                    p.uploads ? "upload_off" : "upload_on",
                  ),
                ],
                [
                  select(
                    p.deletions ? "Выключить удаление" : "Включить удаление",
                    p.deletions ? "delete_off" : "delete_on",
                  ),
                ],
              ]
            : [
                [
                  select(`${p.people === "ids" ? "✓ " : ""}Только ID`, "ids"),
                  select(`${p.people === "names" ? "✓ " : ""}Имена`, "names"),
                ],
                [
                  select(
                    `${p.people === "work" ? "✓ " : ""}Рабочий профиль`,
                    "work",
                  ),
                ],
                ...(p.people === "work"
                  ? [
                      [
                        select(
                          p.email ? "Скрыть email" : "Разрешить email",
                          p.email ? "email_off" : "email_on",
                        ),
                      ],
                    ]
                  : []),
              ];
        rows.unshift(...options);
      }
      const mode =
        p.mode === "read_only"
          ? "только чтение"
          : "запись через превью и подтверждение";
      const people = {
        ids: "только ID",
        names: "ID и имена",
        work: "рабочий профиль",
      }[p.people];
      if (page === "privacy")
        body = `Сотрудники: ${people}\nEmail: ${p.email ? "разрешён настройкой" : "скрыт"}\n\nНастройка ограничивает структурированные поля сотрудников. Тексты задач, обсуждения и документы могут содержать персональные сведения. Уже полученные данные и память Ивы не очищаются.`;
      else if (page === "actions")
        body = `Режим: ${mode}\nЗагрузка в Bitrix: ${p.uploads ? "разрешена настройкой" : "выключена"}\nУдаление сообщений и файлов: ${p.deletions ? "разрешено настройкой" : "выключено"}\n\nЗагрузка и удаление доступны только в режиме записи и при достаточных правах webhook.`;
      else
        body = `Действия: ${mode}\nСотрудники: ${people}\nEmail: ${p.email ? "разрешён настройкой" : "скрыт"}`;
      body += `\n\n${parsed.revision === 0 ? "Исходные настройки установки" : `Ревизия настроек: ${parsed.revision}`}\n${editable ? "Изменения — после отдельного подтверждения." : page === "home" ? "Просмотр настроек. Изменения — через Иву." : "Для изменения попросите Иву: «Покажи настройки Битрикс»."}`;
    }
  } catch {
    body =
      "Не удалось получить сведения от плагина Bitrix24. Настройки не изменены.\n\nПовторите проверку. Если ошибка сохраняется, попросите Иву проверить установку и подключение Битрикса. Секрет webhook в чат не отправляйте.";
  }
  return { title: titles[page], body, rows };
}

export async function bitrixChangePage(
  id: string,
  change: BitrixChange,
  read: BitrixRead,
): Promise<View> {
  changeId.parse(id);
  const parts = id.split(":");
  const op = parts[1];
  if (op !== "set") z.uuid().parse(parts[2]);
  try {
    const result = await change(
      op === "set"
        ? `b24s:set:${parts[2]}:${parts[3]}`
        : `b24s:${op}:${parts[2]}`,
    );
    if (
      op === "set" &&
      (result as { state?: unknown })?.state === "confirmation_required"
    ) {
      const offer = z
        .object({
          state: z.literal("confirmation_required"),
          settings,
          expiresAt: z.iso.datetime(),
          confirmReply: z.string(),
          cancelReply: z.string(),
          approvalPrompt: z.string().min(1).max(2300),
        })
        .parse(result);
      const token = offer.confirmReply.replace(/^b24s:confirm:/, "");
      z.uuid().parse(token);
      if (
        offer.confirmReply !== `b24s:confirm:${token}` ||
        offer.cancelReply !== `b24s:cancel:${token}` ||
        offer.settings.revision !== Number(parts[2]) ||
        Date.parse(offer.expiresAt) <= Date.now()
      )
        throw new Error("INVALID_OFFER");
      return {
        title: "Изменить настройки Bitrix24",
        body: offer.approvalPrompt.replace(
          /^Изменить настройки Bitrix24\?\n\n/,
          "",
        ),
        rows: [
          [
            {
              id: `bitrix:confirm:${token}:${offer.settings.revision}`,
              label: "Подтвердить",
            },
            {
              id: `bitrix:cancel:${token}:${offer.settings.revision}`,
              label: "Отменить",
            },
          ],
        ],
      };
    }
    const current = z
      .object({ state: z.literal("screen"), settings })
      .parse(result).settings;
    const expected = Number(op === "set" ? parts[2] : parts[3]);
    if (current.revision !== expected + (op === "confirm" ? 1 : 0))
      throw new Error("UNKNOWN_RESULT");
    const page = await bitrixPage(
      "home",
      async () => ({ state: "screen", settings: current }),
      true,
    );
    page.body = `${op === "confirm" ? "Настройки сохранены. Прежнее превью задачи отменено." : op === "cancel" ? "Изменение отменено." : "Эта настройка уже выбрана. Прежнее предложение отменено."}\n\n${page.body}`;
    return page;
  } catch (error) {
    const known = error instanceof BitrixError && error.code !== "UNKNOWN";
    const page = await bitrixPage("home", read, true);
    page.body = `${known ? "Предложение устарело или настройки заняты. Обновите сведения и сделайте выбор заново." : "Результат изменения не подтверждён. Запрос не повторяется автоматически. Проверьте текущие настройки перед новым выбором."}\n\n${page.body}`;
    return page;
  }
}
