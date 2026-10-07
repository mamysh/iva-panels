import { readFile, stat } from "node:fs/promises";
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
const titles: Record<string, string> = {
  "bitrix24-read": "Bitrix24",
  "file-delivery": "Отправка файлов",
};
const registry = z
  .object({
    plugins: z.array(
      z
        .object({
          name: z.string(),
          version: z.string().optional(),
          enabled: z.boolean(),
          trusted: z.boolean(),
          sha: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
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
      const path = join(data, "custom", "plugins.json");
      if ((await stat(path)).size > 5 * 1024 * 1024)
        throw new Error("REGISTRY_TOO_LARGE");
      const plugins = registry.parse(
        JSON.parse(await readFile(path, "utf8")),
      ).plugins;
      const available = plugins.filter(
        (p) => titles[p.name] && p.enabled && p.trusted,
      );
      const navigation = [
        { id: "home", label: "К плагинам" },
        { id: "close", label: "Закрыть" },
      ];
      if (id === "home")
        return {
          title: "Плагины",
          body: "Локальное состояние установленных интеграций. Доступность внешних сервисов здесь не проверяется.",
          rows: [
            ...available.map((p) => [{ id: p.name, label: titles[p.name] }]),
            [{ id: "close", label: "Закрыть" }],
          ],
        };
      const name = id.startsWith("bitrix:")
        ? "bitrix24-read"
        : id.startsWith("files:")
          ? "file-delivery"
          : id;
      const plugin = available.find((p) => p.name === name);
      if (!plugin) throw new Error("PLUGIN_UNAVAILABLE");
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
