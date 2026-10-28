import { build } from "esbuild";
import { readFile } from "node:fs/promises";
for (const entry of [
  "server",
  "lifecycle-worker",
  "native-manager",
  "inspect",
  "install",
]) {
  const output = `plugin/sh.iva/services/router/${entry}.mjs`;
  const result = await build({
    entryPoints: [`plugin/sh.iva/services/router/${entry}.ts`],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    write: false,
    legalComments: "inline",
    minifyWhitespace: true,
    banner: {
      js: "/*! iva-panels: MIT. Includes third-party components; see plugin/THIRD_PARTY_NOTICES.md. */\nimport { createRequire as __ivaCreateRequire } from 'node:module'; const require = __ivaCreateRequire(import.meta.url);",
    },
  });
  const text = result.outputFiles[0].contents;
  if (process.argv.includes("--check")) {
    if (!Buffer.from(text).equals(await readFile(output)))
      throw new Error(`Service bundle is stale: ${output}`);
  } else {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(output, text);
  }
}
