import { setupWorker } from "./setup-system.ts";
import { setupState } from "./setup.ts";
import { serveChatCards } from "./chat-cards.ts";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { configSchema } from "./contracts.ts";
import { Store } from "./store.ts";
import { Engine } from "./engine.ts";
import { installedPanels } from "./providers.ts";
import { telegram, acknowledgeCallback } from "./telegram.ts";
import { createRouter } from "./router.ts";
import { DynamicPanels } from "./dynamic.ts";
import { Lifecycle } from "./lifecycle.ts";
async function start() {
  const data = process.env.PLUGIN_DATA;
  const ivaData = process.env.IVA_DATA_DIR;
  const port = Number(process.env.IVA_SERVICE_PORT);
  if (!data || !ivaData || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("ENV_REQUIRED");
  const plugin = process.env.PLUGIN_ROOT;
  const path = join(data, "config.json");
  const missing = !(await stat(path).catch(() => undefined));
  const pending = await setupState(data);
  let prepared = false;
  if (missing || pending) {
    if (!plugin) throw new Error("ENV_REQUIRED");
    prepared = (await setupWorker(plugin, ivaData, "internal-prepare"))
      .prepared;
  }
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
      config.dynamicPanels ? new DynamicPanels(ivaData, data) : undefined,
      { mode: config.mode, presentation: config.presentation },
    ),
    telegram(config.botToken, config.presentation),
  );
  const cards =
    config.dynamicPanels && config.mode === "panels"
      ? await serveChatCards(data, engine, config.owners)
      : undefined;
  const server = createRouter(config, engine, (id) =>
    acknowledgeCallback(config.botToken, id),
  );
  server.on("error", () => {
    console.error("iva-panels: listener failed");
    process.exitCode = 1;
  });
  await new Promise<void>((ready, fail) => {
    server.once("error", fail);
    server.listen(port, "127.0.0.1", ready);
  });
  console.log(`iva-panels: listening on loopback (${config.mode})`);
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => {
      cards?.close();
      server.close(() => {});
      setTimeout(() => {
        server.closeAllConnections();
      }, 5000).unref();
    });
  if (prepared && plugin) {
    try {
      const activated = await setupWorker(plugin, ivaData, "internal-activate");
      if (activated.id) {
        const result = await engine.issue(
          activated.id,
          "welcome",
          config.owners[0],
        );
        await setupWorker(
          plugin,
          ivaData,
          result.state === "presented"
            ? "internal-notice-presented"
            : "internal-notice-unknown",
        );
      }
    } catch {
      console.error(
        "iva-panels: setup did not finish; inspect installer status before retrying",
      );
    }
  }
}
start().catch((error) => {
  const code = /^SETUP_[A-Z_]+$/.test(error?.message)
    ? ` (${error.message})`
    : "";
  console.error(
    `iva-panels: startup failed; check private config and data${code}`,
  );
  process.exitCode = 1;
});
