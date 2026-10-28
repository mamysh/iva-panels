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
  report?: { state: string; next: string },
): View {
  return {
    title: `${p.name} · Подключение настроек`,
    body:
      `Доступ в Panels: ${enabled ? "включён" : "выключен оператором"}.\nСостояние: ${report?.state === "ready" ? "чтение API проверено" : status.label}.\n\n${report?.next ?? (enabled ? "Проверьте поддержку API в самом плагине." : "Доступ к API выключен в Panels; нужна проверка оператора.")}\n\n` +
      (report?.state === "ready" ||
      report?.state === "disabled" ||
      report?.state === "paused" ||
      report?.state === "unavailable"
        ? ""
        : `Для доработки отправьте Иве:\n«Подключи плагин ${p.name} к Panels. Загрузи iva-panels-integration. Сначала выполни поставляемую диагностику inspect.mjs для ${p.name}. Добавь только недостающие возможности в исходниках этого плагина, сохрани его обычную работу. Покажи изменения и тесты».\n\n`) +
      "Открытие этой страницы не устанавливает код и не меняет доверие. Для обычного поручения или подтверждения оставайтесь в чате с Ивой.",
    rows: [
      [
        { id: cardId(p.name), label: "Назад" },
        { id: "close", label: "Закрыть" },
      ],
    ],
  };
}
