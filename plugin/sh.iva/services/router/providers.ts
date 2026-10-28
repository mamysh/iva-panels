import { join } from "node:path";
import { z } from "zod";
import { VERSION, type View } from "./contracts.ts";
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
import {
  DynamicPanels,
  dynamicDefinition,
  dynamicReadId,
  isDynamicMutation,
} from "./dynamic.ts";
import { inspectIntegration } from "./integration.ts";
import { connectionPage, connectionStatus } from "./connection.ts";
import { Lifecycle, isLifecycleMutation } from "./lifecycle.ts";
const titles: Record<string, string> = {
  "bitrix24-read": "Bitrix24",
  "file-delivery": "Отправка файлов",
  "iva-panels": "Panels",
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
  recover?(id?: string): Promise<View>;
}
export function installedPanels(
  data: string,
  bitrixReadOnly = false,
  readBitrix: BitrixRead = bitrixReader(data),
  bitrixSettings = false,
  changeBitrix: BitrixChange = bitrixChanger(data),
  checkFiles: FileCheck = fileUpdateCheck(),
  lifecycle?: Lifecycle,
  dynamic?: DynamicPanels,
  interfaceStatus?: { mode: string; presentation: string },
): Provider {
  const provider: Provider = {
    isMutation: (id) =>
      isBitrixChange(id) || isLifecycleMutation(id) || isDynamicMutation(id),
    async recover(id) {
      if (id?.startsWith("dyn:")) {
        const plugins = registry.parse(
          await smallJson(join(data, "custom/plugins.json"), 5 * 1024 * 1024),
        ).plugins;
        const plugin = plugins.find(
          (p) => pluginKey(p.name) === id.split(":")[2],
        );
        if (plugin && dynamic) return dynamic.recover(plugin);
        return {
          title: "Плагин недоступен",
          body: "Запрос не повторяется. Проверьте результат у плагина.",
          rows: [
            [
              { id: "home", label: "К плагинам" },
              { id: "close", label: "Закрыть" },
            ],
          ],
        };
      }
      if (id?.startsWith("life:"))
        return lifecycle
          ? lifecycle.recover(id)
          : {
              title: "Управление выключено",
              body: "Команда повторно не выполнялась.",
              rows: [
                [
                  { id: "home", label: "К плагинам" },
                  { id: "close", label: "Закрыть" },
                ],
              ],
            };
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
      if (id.startsWith("life:")) {
        if (!lifecycle)
          return {
            title: "Управление выключено",
            body: "Управление запуском через Panels не настроено.",
            rows: [
              [
                { id: "home", label: "К плагинам" },
                { id: "close", label: "Закрыть" },
              ],
            ],
          };
        return lifecycle.page(id);
      }
      if (id === "help")
        return {
          title: "Как пользоваться",
          body: "Поручение: напишите Иве, что нужно сделать. Для обычной задачи достаточно сообщения в чате.\n\nПодтверждение: поддерживающий эту возможность плагин покажет карточку с итогом и кнопками прямо в чате. Открывать каталог для этого не нужно.\n\nНастройки: выберите плагин в списке. Кнопка «О плагине» рядом открывает версию, подключение и включение/выключение.\n\n«В задачи» в сообщении Ивы сохраняет пункт в её обычный список. Это не подтверждение и не отправка сообщения от вашего имени.",
          rows: [
            [
              { id: "home", label: "К плагинам" },
              { id: "close", label: "Закрыть" },
            ],
          ],
        };
      if (id === "panels")
        return {
          title: "Panels · Состояние",
          body: `Версия: ${VERSION}\nИнтерфейс: ${interfaceStatus?.mode === "passthrough" ? "сквозной режим" : "панели"}\nКарточки: ${interfaceStatus?.presentation === "classic" ? "обычные кнопки" : "компактные кнопки"}\nAPI плагинов: ${dynamic ? "включён" : "выключен"}\nВключение/выключение: ${lifecycle ? "настроено; совместимость проверяется перед действием" : "не настроено"}\n\nPanels уже обслуживает этот интерфейс. Подключать его к самому себе не нужно.\nДля действий напишите Иве; подтверждение поддерживаемой операции появится прямо в чате. Параметры соединения меняет оператор, секреты здесь не показываются.`,
          rows: [
            [{ id: "help", label: "Как пользоваться" }],
            [
              { id: "home", label: "К плагинам" },
              { id: "close", label: "Закрыть" },
            ],
          ],
        };
      if (id.startsWith("open:")) {
        const p = plugins.find((p) => `open:${pluginKey(p.name)}` === id);
        if (!p)
          return {
            title: "Плагин не найден",
            body: "Проверьте имя в списке установленных плагинов.",
            rows: [
              [
                { id: "home", label: "К плагинам" },
                { id: "close", label: "Закрыть" },
              ],
            ],
          };
        if (p.name === "iva-panels") return provider.page("panels");
        if (p.enabled && p.trusted) {
          const metadata = await pluginMetadata(data, p);
          const d = await dynamicDefinition(data, p, metadata?.version);
          if (d && dynamic)
            return provider.page(dynamicReadId(p.name, d.entry));
          const staticPanel = await pluginDefinition(
            data,
            p,
            metadata?.version,
          );
          if (staticPanel)
            return provider.page(
              `panel:${pluginKey(p.name)}:${staticPanel.entry}`,
            );
          if (titles[p.name] && (p.name !== "bitrix24-read" || bitrixReadOnly))
            return provider.page(p.name);
        }
        return provider.page(cardId(p.name));
      }
      const manage = (view: View, name: string): View =>
        lifecycle
          ? {
              ...view,
              rows: [
                ...view.rows.slice(0, -1),
                [
                  {
                    id: `life:open:${pluginKey(name)}`,
                    label: "Включить / выключить",
                  },
                ],
                ...view.rows.slice(-1),
              ],
            }
          : view;
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
              id: `open:${pluginKey(p.name)}`,
              label: `${(titles[p.name] ?? p.name).slice(0, 45)}${!p.enabled ? " · выключен" : !p.trusted ? " · без доверия" : ""}`,
            },
            { id: cardId(p.name), label: "О плагине" },
          ]);
        const paging = [
          ...(page > 0
            ? [{ id: `catalog:${page - 1}`, label: "Предыдущие" }]
            : []),
          ...(page < pages - 1
            ? [{ id: `catalog:${page + 1}`, label: "Следующие" }]
            : []),
        ];
        return {
          title: "Плагины",
          body: `Установлено: ${plugins.length}\nСтраница ${page + 1} из ${pages}\n\nНажмите название, чтобы открыть настройки или доступные возможности. «О плагине» — сведения и управление. Для поручения просто напишите Иве.`,
          rows: [
            ...rows,
            ...(paging.length ? [paging] : []),
            [{ id: "help", label: "Как пользоваться" }],
            [
              { id: `catalog:${page}`, label: "Обновить список" },
              { id: "close", label: "Закрыть" },
            ],
          ],
        };
      }
      const external =
        /^(dyn|connect):(?:([a-z]+):)?([a-f0-9]{24})(?::.*)?$/.exec(id);
      if (external) {
        const plugin = plugins.find((p) => pluginKey(p.name) === external[3]);
        if (!plugin)
          return {
            title: "Плагин недоступен",
            body: "Обновите список плагинов.",
            rows: [navigation],
          };
        const metadata = await pluginMetadata(data, plugin);
        if (plugin.name === "iva-panels") return provider.page("panels");
        if (external[1] === "connect")
          return connectionPage(
            plugin,
            await connectionStatus(data, plugin, metadata?.version),
            Boolean(dynamic),
            await inspectIntegration(data, plugin.name, Boolean(dynamic)),
          );
        const definition = await dynamicDefinition(
          data,
          plugin,
          metadata?.version,
        );
        if (!definition || !dynamic)
          return connectionPage(
            plugin,
            await connectionStatus(data, plugin, metadata?.version),
            Boolean(dynamic),
          );
        return dynamic.page(id, plugin, definition);
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
        if (matches[0].name === "iva-panels") return provider.page("panels");
        const p = matches[0],
          metadata = await pluginMetadata(data, p);
        const definition = await pluginDefinition(data, p, metadata?.version);
        if (
          generic[1] === "panel" &&
          definition?.pages.some((page) => page.id === generic[3])
        )
          return definitionPage(p.name, definition, generic[3]);
        const dynamicDescriptor = await dynamicDefinition(
          data,
          p,
          metadata?.version,
        );
        const status = await connectionStatus(data, p, metadata?.version);
        const card = basicCard(
          p,
          metadata,
          definition,
          dynamicDescriptor
            ? `Плагин предоставляет общий API Panels. ${dynamic ? "Откройте раздел, чтобы проверить доступность." : "Доступ к API выключен оператором Panels."}`
            : undefined,
        );
        card.title = titles[p.name] ?? card.title;
        card.body += `\n\nСвязь с Panels: ${status.label}`;
        card.rows.splice(
          -2,
          0,
          ...(dynamicDescriptor && dynamic
            ? [
                [
                  {
                    id: dynamicReadId(p.name, dynamicDescriptor.entry),
                    label:
                      dynamicDescriptor.capabilities.length === 2
                        ? "Настройки и действия"
                        : dynamicDescriptor.capabilities[0] === "settings"
                          ? "Настройки"
                          : "Действия плагина",
                  },
                ],
              ]
            : []),
          [
            {
              id: `connect:${pluginKey(p.name)}`,
              label:
                status.kind === "dynamic"
                  ? "Проверить подключение"
                  : "Как добавить настройки",
            },
          ],
          ...(!dynamicDescriptor && titles[p.name] && p.enabled && p.trusted
            ? [[{ id: p.name, label: "Возможности плагина" }]]
            : []),
        );
        return manage(card, p.name);
      }
      const name = id.startsWith("bitrix:")
        ? "bitrix24-read"
        : id.startsWith("files:")
          ? "file-delivery"
          : id;
      const plugin = plugins.find((p) => p.name === name);
      if (!plugin) throw new Error("PLUGIN_UNAVAILABLE");
      if (!plugin.enabled || !plugin.trusted)
        return manage(
          basicCard(plugin, await pluginMetadata(data, plugin)),
          plugin.name,
        );
      if (!titles[name]) throw new Error("PLUGIN_UNAVAILABLE");
      if (name === "file-delivery")
        return id === name
          ? manage(await filePage(data, id, plugin.sha, checkFiles), name)
          : filePage(data, id, plugin.sha, checkFiles);
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
        return id === name
          ? manage(await bitrixPage("home", readBitrix, bitrixSettings), name)
          : bitrixPage(id.slice(7), readBitrix, bitrixSettings);
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
      return manage(
        {
          title: titles[id],
          body: `Включён: да\nДоверие: разрешено\nCommit: ${plugin.sha?.slice(0, 12) ?? "не указан"}\n\nПодключение к внешнему сервису: не проверено.\nПоказано состояние регистрации в Иве; права и настройки интеграции не изменяются.`,
          rows: [[{ id, label: "Обновить сведения" }], navigation],
        },
        plugin.name,
      );
    },
  };
  return provider;
}
