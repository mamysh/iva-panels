import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cardId } from "../plugin/sh.iva/services/router/catalog.ts";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
test("catalog includes unknown and untrusted plugins; built-in adapters remain guarded", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "panels-registry-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(join(data, "custom"));
  await writeFile(
    join(data, "custom/plugins.json"),
    JSON.stringify({
      plugins: [
        {
          name: "bitrix24-read",
          enabled: true,
          trusted: true,
          sha: "a".repeat(40),
        },
        { name: "file-delivery", enabled: true, trusted: false },
        { name: "unknown", enabled: true, trusted: true },
      ],
    }),
  );
  const provider = installedPanels(data);
  const home = await provider.page("home");
  assert.equal(home.rows.length, 4);
  assert.equal(home.rows[0][0].id, cardId("bitrix24-read"));
  assert((await provider.page("bitrix24-read")).body.includes("не проверено"));
  assert((await provider.page("file-delivery")).body.includes("не разрешено"));
  await assert.rejects(provider.page("unknown"));
});
