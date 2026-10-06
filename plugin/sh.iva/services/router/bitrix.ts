import { readFile, stat } from "node:fs/promises";
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
export function bitrixReader(data: string): BitrixRead {
  return async (section) => {
    const root = join(data, "custom", "plugins", "bitrix24-read");
    const manifest = JSON.parse(
      await readFile(join(root, "plugin.json"), "utf8"),
    );
    if (manifest.name !== "bitrix24-read" || manifest.version !== "0.9.0-rc.1")
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
      args: [join(root, "server.mjs")],
      cwd: root,
      env: env as Record<string, string>,
      stderr: "ignore",
      maxBufferSize: 256 * 1024,
    });
    const client = new Client({
      name: "iva-panels-read-only",
      version: VERSION,
    });
    const signal = AbortSignal.timeout(15_000);
    try {
      await client.connect(transport, { signal, timeout: 15_000 });
      const tool =
        section === "connection"
          ? "bitrix24_connection_check"
          : section === "capabilities"
            ? "bitrix24_capabilities"
            : "bitrix24_settings";
      const args =
        tool === "bitrix24_settings"
          ? { screen: section === "privacy" ? "privacy" : "actions" }
          : {};
      const result = await client.callTool(
        { name: tool, arguments: args },
        undefined,
        { signal, timeout: 15_000 },
      );
      if (result.isError) throw new Error("BITRIX_CHECK_FAILED");
      const content = result.content as Array<{ type: string; text?: string }>;
      if (
        content.length !== 1 ||
        content[0].type !== "text" ||
        !content[0].text ||
        content[0].text.length > 65536
      )
        throw new Error("BITRIX_RESPONSE_INVALID");
      return JSON.parse(content[0].text);
    } finally {
      await client.close();
    }
  };
}

export async function bitrixPage(
  section: string,
  read: BitrixRead,
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
            { id: id("privacy"), label: "Данные сотрудников" },
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
        body = `Действия: ${mode}\nСотрудники: ${people}\nEmail: ${p.email ? "разрешён настройкой" : "скрыт"}\n\nВыберите раздел, чтобы посмотреть настройки или проверить подключение.`;
      body += `\n\n${parsed.revision === 0 ? "Исходные настройки установки" : `Ревизия настроек: ${parsed.revision}`}\nЗдесь доступен просмотр. Для изменения попросите Иву: «Покажи настройки Битрикс».`;
    }
  } catch {
    body =
      "Не удалось получить сведения от плагина Bitrix24. Настройки не изменены.\n\nПовторите проверку. Если ошибка сохраняется, попросите Иву проверить установку и подключение Битрикса. Секрет webhook в чат не отправляйте.";
  }
  return { title: titles[page], body, rows };
}
