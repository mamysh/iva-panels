import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  validateDefinition,
  smallJson,
  pluginName,
} from "../plugin/sh.iva/services/router/catalog.ts";
import { z } from "zod";
const root = process.argv[2];
if (!root)
  throw new Error(
    "Pass a plugin directory containing plugin.json and panels.json",
  );
const manifest = z
  .object({ name: pluginName, version: z.string() })
  .parse(JSON.parse(await readFile(join(root, "plugin.json"), "utf8")));
const raw = await smallJson(join(root, "panels.json"), 32768);
if (raw.schema === "iva-panels/v2") {
  const { validateDynamicDefinition } =
    await import("../plugin/sh.iva/services/router/dynamic.ts");
  validateDynamicDefinition(raw, manifest.name, manifest.version);
  console.log(
    "Panel contract valid: dynamic settings/actions API (socket not checked)",
  );
} else {
  const definition = validateDefinition(raw, manifest.name, manifest.version);
  console.log(`Panel contract valid: ${definition.pages.length} pages`);
}
