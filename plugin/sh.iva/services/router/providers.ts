import { join } from "node:path";
import { z } from "zod";
import type { View } from "./contracts.ts";
import {
  bitrixPage,
  bitrixReader,
  bitrixChanger,
  bitrixChangePage,
  isBitrixChange,
  type BitrixRead,
  type BitrixChange,
} from "./bitrix.ts";
import { filePage, fileUpdateCheck, type FileCheck } from "./files.ts";
import {
  entrySchema,
  smallJson,
  cardId,
  pluginKey,
  pluginMetadata,
  pluginDefinition,
  definitionPage,
  basicCard,
} from "./catalog.ts";
const titles: Record<string, string> = {
  "bitrix24-read": "Bitrix24",
  "file-delivery": "Отправка файлов",
};
const registry = z
  .object({ plugins: z.array(entrySchema).max(1000) })
  .passthrough()
  .refine(
    (r) => new Set(r.plugins.map((p) => p.name)).size === r.plugins.length,
  );
const PAGE_SIZE = 5;
export interface Provider {
  page(id: string): Promise<View>;
  isMutation?(id: string): boolean;
  recover?(): Promise<View>;
}
export function installedPanels(
  data: string,
  bitrixReadOnly = false,
  readBitrix: BitrixRead = bitrixReader(data),
  bitrixSettings = false,
  changeBitrix: BitrixChange = bitrixChanger(data),
  checkFiles: FileCheck = fileUpdateCheck(),
): Provider {
  const provider: Provider = {
    isMutation: (id) => isBitrixChange(id),
    async recover() {
      let page: View;
      try {
        page = await provider.page("bitrix24-read");
      } catch {
        page = {
          title: "Bitrix24",
          body: "Сведения временно недоступны.",
          rows: [
            [
              { id: "home", label: "К плагинам" },
              { id: "close", label: "Закрыть" },
            ],
          ],
        };
      }
      return {
        ...page,
        body: `Запрос был прерван. Его результат не подтверждён; повторного изменения не выполнялось. Проверьте текущие настройки перед новым выбором.\n\n${page.body}`,
      };
    },
    async page(id) {
      const plugins = registry.parse(
        await smallJson(join(data, "custom/plugins.json"), 5 * 1024 * 1024),
      ).plugins;
      const navigation = [
        { id: "home", label: "К плагинам" },
        { id: "close", label: "Закрыть" },
      ];
      if (id === "home" || /^catalog:(0|[1-9]\d{0,2})$/.test(id)) {
        const pages = Math.max(1, Math.ceil(plugins.length / PAGE_SIZE));
        const page = Math.min(
          id === "home" ? 0 : Number(id.slice(8)),
          pages - 1,
        );
        const rows = plugins
          .slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
          .map((p) => [
            {
              id:
                titles[p.name] && p.enabled && p.trusted
                  ? p.name
                  : cardId(p.name),
              label: `${(titles[p.name] ?? p.name).slice(0, 45)}${!p.enabled ? " · выключен" : !p.trusted ? " · без доверия" : ""}`,
            },
          ]);
        const paging = [
          ...(page > 0 ? [{ id: `catalog:${page - 1}`, label: "Назад" }] : []),
          ...(page < pages - 1
            ? [{ id: `catalog:${page + 1}`, label: "Далее" }]
            : []),
        ];
        return {
          title: "Плагины",
          body: `Установлено: ${plugins.length}\nСтраница ${page + 1} из ${pages}\n\nСостояние регистрации в Иве. Работу служб и внешних сервисов здесь не проверяли.`,
          rows: [
            ...rows,
            ...(paging.length ? [paging] : []),
            [
              { id: `catalog:${page}`, label: "Обновить список" },
              { id: "close", label: "Закрыть" },
            ],
          ],
        };
      }
      const generic =
        /^(plugin|panel):([a-f0-9]{24})(?::([a-z][a-z0-9-]{0,23}))?$/.exec(id);
      if (generic) {
        if ((generic[1] === "plugin") === Boolean(generic[3]))
          throw new Error("PLUGIN_UNAVAILABLE");
        const matches = plugins.filter((p) => pluginKey(p.name) === generic[2]);
        if (matches.length !== 1)
          return {
            title: "Плагин недоступен",
            body: "Плагин удалён или список изменился. Обновите список.",
            rows: [navigation],
          };
        const p = matches[0],
          metadata = await pluginMetadata(data, p);
        const definition = await pluginDefinition(data, p, metadata?.version);
        if (
          generic[1] === "panel" &&
          definition?.pages.some((page) => page.id === generic[3])
        )
          return definitionPage(p.name, definition, generic[3]);
        return basicCard(p, metadata, definition);
      }
      const name = id.startsWith("bitrix:")
        ? "bitrix24-read"
        : id.startsWith("files:")
          ? "file-delivery"
          : id;
      const plugin = plugins.find((p) => p.name === name);
      if (!plugin) throw new Error("PLUGIN_UNAVAILABLE");
      if (!plugin.enabled || !plugin.trusted)
        return basicCard(plugin, await pluginMetadata(data, plugin));
      if (!titles[name]) throw new Error("PLUGIN_UNAVAILABLE");
      if (name === "file-delivery")
        return filePage(data, id, plugin.sha, checkFiles);
      if (isBitrixChange(id)) {
        if (!bitrixReadOnly || !bitrixSettings)
          return {
            title: "Bitrix24",
            body: "Изменение настроек через панели выключено.",
            rows: [navigation],
          };
        return bitrixChangePage(id, changeBitrix, readBitrix);
      }
      if (bitrixReadOnly && name === "bitrix24-read")
        return bitrixPage(
          id === name ? "home" : id.slice(7),
          readBitrix,
          bitrixSettings,
        );
      if (id !== name) {
        if (
          ![
            "bitrix:connection",
            "bitrix:capabilities",
            "bitrix:actions",
            "bitrix:privacy",
          ].includes(id)
        )
          throw new Error("PLUGIN_UNAVAILABLE");
        return {
          title: "Bitrix24",
          body: "Просмотр настроек в панелях выключен. Для настройки попросите Иву: «Покажи настройки Битрикс».",
          rows: [navigation],
        };
      }
      return {
        title: titles[id],
        body: `Включён: да\nДоверие: разрешено\nCommit: ${plugin.sha?.slice(0, 12) ?? "не указан"}\n\nПодключение к внешнему сервису: не проверено.\nПоказано состояние регистрации в Иве; права и настройки интеграции не изменяются.`,
        rows: [[{ id, label: "Обновить сведения" }], navigation],
      };
    },
  };
  return provider;
}
