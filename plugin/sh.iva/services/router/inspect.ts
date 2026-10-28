import { join } from "node:path";
import { configSchema } from "./contracts.ts";
import { smallJson } from "./catalog.ts";
import { inspectIntegration } from "./integration.ts";

const [data, name, ...extra] = process.argv.slice(2);
try {
  if (!data?.startsWith("/") || !name || extra.length)
    throw new Error("ARGUMENTS");
  let enabled = false;
  let configuration = "unavailable";
  try {
    const c = configSchema.parse(
      await smallJson(join(data, "plugin-data/iva-panels/config.json"), 16384),
    );
    enabled = c.dynamicPanels && c.mode === "panels";
    configuration = "read";
  } catch {
    /* Report no private config values or errors. */
  }
  const result = await inspectIntegration(data, name, enabled);
  console.log(
    JSON.stringify({
      schema: "iva-panels/inspection-v1",
      configuration,
      ...result,
    }),
  );
} catch {
  console.log(
    JSON.stringify({
      error: "INSPECTION_UNAVAILABLE",
      usage: "node inspect.mjs ABSOLUTE_IVA_DATA_DIR PLUGIN_NAME",
    }),
  );
  process.exitCode = 1;
}
