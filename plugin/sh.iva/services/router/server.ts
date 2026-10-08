import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "./contracts.ts";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { installedPanels } from "./providers.ts";
import { telegram, acknowledgeCallback } from "./telegram.ts";
import { createRouter } from "./router.ts";
import { Lifecycle } from "./lifecycle.ts";
async function start() {
  const data = process.env.PLUGIN_DATA;
  const ivaData = process.env.IVA_DATA_DIR;
  const port = Number(process.env.IVA_SERVICE_PORT);
  if (!data || !ivaData || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ENV_REQUIRED");
  const path = join(data, "config.json");
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16384)
    throw new Error("PRIVATE_CONFIG_REQUIRED");
  const config = configSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (Number(new URL(config.upstream).port || 80) === port)
    throw new Error("SELF_UPSTREAM");
  const store = new Store(data);
  await store.load();
  const engine = new Engine(
    store,
    installedPanels(
      ivaData,
      config.bitrixReadOnly,
      undefined,
      config.bitrixSettings,
      undefined,
      undefined,
      config.lifecycle
        ? new Lifecycle(ivaData, data, config.lifecycle)
        : undefined,
    ),
    telegram(config.botToken, config.presentation),
  );
  const server = createRouter(config, engine, (id) =>
    acknowledgeCallback(config.botToken, id),
  );
  server.on("error", () => {
    console.error("iva-panels: listener failed");
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () =>
    console.log(`iva-panels: listening on loopback (${config.mode})`),
  );
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      server.close(() => {});
      setTimeout(() => {
        server.closeAllConnections();
      }, 5000).unref();
    });
}
start().catch(() => {
  console.error("iva-panels: startup failed; check private config and data");
  process.exitCode = 1;
});
