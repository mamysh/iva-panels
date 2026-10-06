import { build } from "esbuild";
import { readFile } from "node:fs/promises";
const output = "plugin/sh.iva/services/router/server.mjs";
const result = await build({
  entryPoints: ["plugin/sh.iva/services/router/server.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  write: false,
  legalComments: "inline",
  minifyWhitespace: true,
  banner: {
    js: "/*! iva-panels: MIT. Includes Zod: MIT; see plugin/THIRD_PARTY_NOTICES.md. */",
  },
});
const text = result.outputFiles[0].contents;
if (process.argv.includes("--check")) {
  if (!Buffer.from(text).equals(await readFile(output)))
    throw new Error("Service bundle is stale");
} else {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(output, text);
}
