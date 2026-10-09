import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { render, type View } from "./contracts.ts";

export const pluginName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
  .refine((n) => !n.includes("..") && !n.includes("--"));
const version = z
  .string()
  .max(48)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/);
export const entrySchema = z
  .object({
    name: pluginName,
    enabled: z.boolean(),
    trusted: z.boolean(),
    version: version.optional().catch(undefined),
    sha: z.string().max(128).optional(),
  })
  .passthrough();
export type PluginEntry = z.infer<typeof entrySchema>;
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/);
export const panelDefinitionSchema = z
  .object({
    schema: z.literal("iva-panels/v1"),
    plugin: pluginName,
    pluginVersion: version,
    entry: slug,
    pages: z
      .array(
        z
          .object({
            id: slug,
            title: z.string().min(1).max(80),
            body: z.string().max(1500),
            rows: z
              .array(
                z
                  .array(
                    z
                      .object({
                        label: z.string().min(1).max(48),
                        target: slug,
                      })
                      .strict(),
                  )
                  .min(1)
                  .max(2),
              )
              .max(5),
          })
          .strict(),
      )
      .min(1)
      .max(12),
  })
  .strict();
export type PanelDefinition = z.infer<typeof panelDefinitionSchema>;
export async function smallJson(path: string, limit: number) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit)
      throw new Error("METADATA_INVALID");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        size,
        buffer.length - size,
        null,
      );
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw new Error("METADATA_TOO_LARGE");
    return JSON.parse(buffer.subarray(0, size).toString("utf8"));
  } finally {
    await file.close();
  }
}
export function pluginKey(name: string) {
  return createHash("sha256").update(name).digest("hex").slice(0, 24);
}
export function cardId(name: string) {
  return `plugin:${pluginKey(name)}`;
}
export function sectionId(name: string, page: string) {
  return `panel:${pluginKey(name)}:${page}`;
}
export async function pluginMetadata(data: string, plugin: PluginEntry) {
  try {
    return z
      .object({
        name: z.literal(plugin.name),
        version,
        description: z.string().max(500).optional(),
      })
      .parse(
        await smallJson(
          join(data, "custom/plugins", plugin.name, "plugin.json"),
          8192,
        ),
      );
  } catch {
    return undefined;
  }
}
export async function pluginDefinition(
  data: string,
  plugin: PluginEntry,
  installed: string | undefined,
): Promise<PanelDefinition | undefined> {
  if (!plugin.enabled || !plugin.trusted || !installed) return undefined;
  try {
    return validateDefinition(
      await smallJson(
        join(data, "custom/plugins", plugin.name, "panels.json"),
        32768,
      ),
      plugin.name,
      installed,
    );
  } catch {
    return undefined;
  }
}
export function validateDefinition(
  value: unknown,
  name: string,
  installed: string,
): PanelDefinition {
  const definition = panelDefinitionSchema.parse(value);
  if (definition.plugin !== name || definition.pluginVersion !== installed)
    throw new Error("PANEL_IDENTITY_MISMATCH");
  const ids = new Set(definition.pages.map((p) => p.id));
  if (
    ids.size !== definition.pages.length ||
    !ids.has(definition.entry) ||
    definition.pages.some((p) => p.rows.flat().some((b) => !ids.has(b.target)))
  )
    throw new Error("PANEL_TARGET_INVALID");
  for (const page of definition.pages)
    render(definitionPage(name, definition, page.id), "0".repeat(24), 0);
  return definition;
}
export function definitionPage(
  name: string,
  definition: PanelDefinition,
  id: string,
): View {
  const page = definition.pages.find((p) => p.id === id);
  if (!page) throw new Error("PANEL_PAGE_UNAVAILABLE");
  return {
    title: page.title,
    body: page.body,
    rows: [
      ...page.rows.map((row) =>
        row.map((b) => ({ id: sectionId(name, b.target), label: b.label })),
      ),
      [{ id: sectionId(name, id), label: "Обновить раздел" }],
      [
        { id: cardId(name), label: "О плагине" },
        { id: "close", label: "Закрыть" },
      ],
    ],
  };
}
export function basicCard(
  plugin: PluginEntry,
  metadata: Awaited<ReturnType<typeof pluginMetadata>>,
  definition?: PanelDefinition,
  connectionText?: string,
): View {
  return {
    title: plugin.name,
    body: `Версия: ${metadata?.version ?? plugin.version ?? "не удалось прочитать"}\nСостояние: ${plugin.enabled ? "включён" : "выключен"}\nДоверие: ${plugin.trusted ? "разрешено" : "не разрешено"}\nCommit: ${/^[a-f0-9]{40}$/.test(plugin.sha ?? "") ? plugin.sha!.slice(0, 12) : "не указан"}\n\n${metadata?.description ? metadata.description + "\n\n" : ""}${!plugin.enabled || !plugin.trusted ? "Собственные разделы доступны после включения и разрешения доверия через менеджер Ивы." : (connectionText ?? (definition ? "Плагин предоставляет разделы для Panels." : "Дополнительные разделы не подключены или их описание несовместимо."))}\nСтатус регистрации не подтверждает работу службы или внешнего сервиса.`,
    rows: [
      ...(definition
        ? [
            [
              {
                id: sectionId(plugin.name, definition.entry),
                label: "Открыть разделы",
              },
            ],
          ]
        : []),
      [{ id: cardId(plugin.name), label: "Обновить сведения" }],
      [
        { id: "home", label: "К плагинам" },
        { id: "close", label: "Закрыть" },
      ],
    ],
  };
}
