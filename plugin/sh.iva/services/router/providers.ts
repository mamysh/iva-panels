import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { View } from "./contracts.ts";
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
}
export function installedPanels(data: string): Provider {
  return {
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
      const plugin = available.find((p) => p.name === id);
      if (!plugin) throw new Error("PLUGIN_UNAVAILABLE");
      return {
        title: titles[id],
        body: `Включён: да\nДоверие: разрешено\nCommit: ${plugin.sha?.slice(0, 12) ?? "не указан"}\n\nПодключение к внешнему сервису: не проверено.\nПоказано состояние регистрации в Иве; права и настройки интеграции не изменяются.`,
        rows: [[{ id, label: "Обновить сведения" }], navigation],
      };
    },
  };
}
