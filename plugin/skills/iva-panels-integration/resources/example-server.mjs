import { serveSettings } from "./settings-service.mjs";
function validate(value) {
  if (
    !value ||
    Object.keys(value).join() !== "compact" ||
    typeof value.compact !== "boolean"
  )
    throw new Error("INVALID_SETTINGS");
  return { compact: value.compact };
}
const server = await serveSettings({
  name: "dynamic-notes-example",
  version: "1.0.0",
  directory: process.env.PLUGIN_DATA,
  defaults: { compact: false },
  validate,
  screen(page, settings) {
    if (page !== "home") throw new Error("UNKNOWN_PAGE");
    return {
      title: "Заметки · Настройки",
      body: `Компактный вид: ${settings.compact ? "включён" : "выключен"}`,
      rows: [
        [
          {
            label: settings.compact ? "Обычный вид" : "Компактный вид",
            action: "toggle-compact",
          },
        ],
      ],
    };
  },
  propose(action, settings) {
    if (action !== "toggle-compact") throw new Error("UNKNOWN_ACTION");
    return {
      summary: `Компактный вид: ${settings.compact ? "включён → выключен" : "выключен → включён"}`,
      settings: { compact: !settings.compact },
    };
  },
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
