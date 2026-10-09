import { join } from "node:path";
import {
  cardId,
  smallJson,
  validateDefinition,
  type PluginEntry,
} from "./catalog.ts";
import { validateDynamicDefinition } from "./dynamic.ts";
import type { View } from "./contracts.ts";
export type ConnectionStatus = {
  kind: "missing" | "invalid" | "static" | "dynamic" | "paused";
  label: string;
};
export async function connectionStatus(
  data: string,
  p: PluginEntry,
  version?: string,
): Promise<ConnectionStatus> {
  if (!p.enabled || !p.trusted)
    return {
      kind: "paused",
      label: "недоступна до включения и разрешения доверия",
    };
  try {
    const raw = await smallJson(
      join(data, "custom/plugins", p.name, "panels.json"),
      32768,
    );
    if (!version) throw new Error("MANIFEST_INVALID");
    if (raw.schema === "iva-panels/v2") {
      const definition = validateDynamicDefinition(raw, p.name, version);
      return {
        kind: "dynamic",
        label: `объявлен API: ${definition.capabilities.map((c) => (c === "settings" ? "настройки" : "действия")).join(", ")}; доступность проверяется при открытии`,
      };
    }
    validateDefinition(raw, p.name, version);
    return {
      kind: "static",
      label: "информационные разделы v1; настройки и действия не подключены",
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { kind: "missing", label: "общий API не подключён" }
      : { kind: "invalid", label: "описание несовместимо или повреждено" };
  }
}
export function connectionPage(
  p: PluginEntry,
  status: ConnectionStatus,
  enabled: boolean,
): View {
  return {
    title: `${p.name} · Подключение к Panels`,
    body:
      `Связь: ${status.label}.\nОбщий API в Panels: ${enabled ? "разрешён оператором" : "выключен оператором"}.\n\n` +
      `Чтобы подготовить подключение, отправьте Иве:\n\n«Подключи плагин ${p.name} к Panels. Загрузи skill iva-panels-integration из установленного iva-panels, проверь возможности и подготовь совместимый panels.json и API. Сохрани самостоятельную работу плагина. Покажи изменения и результаты тестов перед установкой».\n\n` +
      "Инструкция поставляется с Panels в skills/iva-panels-integration. Кнопка открывает инструкцию; исходники и доверие плагина автоматически не меняются. Поддержка настроек добавляется в сам плагин. Включение/выключение не требует этого API.",
    rows: [
      [
        { id: cardId(p.name), label: "О плагине" },
        { id: "close", label: "Закрыть" },
      ],
    ],
  };
}
