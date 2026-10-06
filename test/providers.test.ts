import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
test("only known enabled trusted integrations are listed; no connectivity claims", async (t) => {
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
  assert.equal(home.rows.length, 2);
  assert.equal(home.rows[0][0].id, "bitrix24-read");
  assert((await provider.page("bitrix24-read")).body.includes("не проверено"));
  await assert.rejects(provider.page("file-delivery"));
  await assert.rejects(provider.page("unknown"));
});
