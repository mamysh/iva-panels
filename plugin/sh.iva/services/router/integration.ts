import { join } from "node:path";
import { z } from "zod";
import {
  entrySchema,
  pluginName,
  pluginMetadata,
  smallJson,
} from "./catalog.ts";
import { connectionStatus } from "./connection.ts";
import {
  dynamicDefinition,
  dynamicScreenSchema,
  socketCall,
  type DynamicCall,
} from "./dynamic.ts";

/** Read-only evidence for the agent. Never emits plugin content, paths or secrets. */
export async function inspectIntegration(
  data: string,
  name: string,
  enabled: boolean,
  call: DynamicCall = socketCall(data),
) {
  pluginName.parse(name);
  const registry = z
    .object({ plugins: z.array(entrySchema).max(1000) })
    .parse(await smallJson(join(data, "custom/plugins.json"), 5 * 1024 * 1024));
  const matches = registry.plugins.filter((p) => p.name === name);
  if (matches.length !== 1)
    return {
      plugin: name,
      state: "not-installed",
      next: "Уточните имя установленного плагина.",
    };
  const p = matches[0];
  const metadata = await pluginMetadata(data, p);
  const base = {
    plugin: name,
    version: metadata?.version,
    enabled: p.enabled,
    trusted: p.trusted,
  };
  if (name === "iva-panels")
    return {
      ...base,
      state: "builtin",
      next: "Panels уже обслуживает интерфейс. Не создавайте panels.json, второй API или службу для подключения к самому себе. Откройте /panels iva-panels.",
    };
  const status = await connectionStatus(data, p, metadata?.version);
  if (status.kind === "paused")
    return {
      ...base,
      state: "paused",
      next: "Нужны включение и доверие через штатный менеджер Ивы. Диагностика их не меняет.",
    };
  if (status.kind === "missing")
    return {
      ...base,
      state: "missing",
      next: "В исходниках выбранного плагина нужно добавить descriptor и API по skill iva-panels-integration. Это доработка плагина, не переключатель Panels.",
    };
  if (status.kind === "invalid")
    return {
      ...base,
      state: "invalid",
      next: "Проверьте имя, версию и schema panels.json в исходниках выбранного плагина. Не меняйте установленную копию для обхода проверки.",
    };
  if (status.kind === "static")
    return {
      ...base,
      state: "static",
      next: "Подключена справка v1. Для живых настроек нужна реализация v2 в самом плагине.",
    };
  if (!enabled)
    return {
      ...base,
      state: "disabled",
      next: "API объявлен, но доступ выключен в Panels. Оператор должен проверить dynamicPanels; исходники плагина переписывать не нужно.",
    };
  const definition = await dynamicDefinition(data, p, metadata?.version);
  if (!definition) throw new Error("PANEL_DEFINITION_CHANGED");
  try {
    dynamicScreenSchema.parse(
      await call(name, definition.pluginVersion, {
        op: "read",
        page: definition.entry,
      }),
    );
    return {
      ...base,
      state: "ready",
      capabilities: definition.capabilities,
      next: `Чтение API работает. Откройте /panels ${name}. Запись, подтверждение и восстановление проверяются отдельно; не заменяйте работающий API новым.`,
    };
  } catch {
    return {
      ...base,
      state: "unavailable",
      next: "Descriptor v2 принят, но служба не отвечает совместимым экраном. Проверьте штатную службу, приватный panels.sock и совпадение версий. Новый descriptor и повтор операции не исправляют эту ошибку.",
    };
  }
}
