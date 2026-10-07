import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
import {
  cardId,
  sectionId,
  panelDefinitionSchema,
} from "../plugin/sh.iva/services/router/catalog.ts";
import { render } from "../plugin/sh.iva/services/router/contracts.ts";
const definition = {
  schema: "iva-panels/v1",
  plugin: "demo",
  pluginVersion: "1.0.0",
  entry: "home",
  pages: [
    {
      id: "home",
      title: "Demo <panel>",
      body: "Local & safe",
      rows: [[{ label: "Details", target: "details" }]],
    },
    {
      id: "details",
      title: "Details",
      body: "Plugin-owned snapshot",
      rows: [[{ label: "Back", target: "home" }]],
    },
  ],
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const data = await mkdtemp(join(tmpdir(), "panels-catalog-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(join(data, "custom/plugins/demo"), { recursive: true });
  await writeFile(
    join(data, "custom/plugins/demo/plugin.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      description: "Synthetic plugin",
    }),
  );
  const entries = [{ name: "demo", enabled: true, trusted: true }];
  const registry = join(data, "custom/plugins.json");
  await writeFile(registry, JSON.stringify({ plugins: entries }));
  const panels = join(data, "custom/plugins/demo/panels.json");
  await writeFile(panels, JSON.stringify(definition));
  return { data, entries, registry, panels, provider: installedPanels(data) };
}
test("all installed plugins discovered; live addition/removal and pagination never rebind stable card IDs", async (t) => {
  const f = await fixture(t);
  f.entries.push(
    ...Array.from({ length: 14 }, (_, i) => ({
      name: `other-${i}`,
      enabled: i % 2 === 0,
      trusted: i % 3 === 0,
    })),
  );
  await writeFile(f.registry, JSON.stringify({ plugins: f.entries }));
  const home = await f.provider.page("home");
  assert.match(home.body, /Установлено: 15/);
  assert.equal(home.rows.length, 7);
  assert.equal(home.rows[0][0].id, cardId("demo"));
  assert(home.rows.flat().some((b) => b.label.includes("выключен")));
  const second = await f.provider.page("catalog:1");
  assert(second.rows.flat().some((b) => b.id === "catalog:0"));
  const key = cardId("other-8");
  const card = await f.provider.page(key);
  assert.equal(card.title, "other-8");
  f.entries.reverse();
  await writeFile(f.registry, JSON.stringify({ plugins: f.entries }));
  assert.equal((await f.provider.page(key)).title, "other-8");
  f.entries.splice(
    f.entries.findIndex((e) => e.name === "other-8"),
    1,
  );
  await writeFile(f.registry, JSON.stringify({ plugins: f.entries }));
  assert.match((await f.provider.page(key)).body, /удалён/);
  for (const id of ["home", "catalog:1", "catalog:2"])
    render(await f.provider.page(id), "0".repeat(24), 1);
});
test("contract discovered without adapter code; scoped navigation, refresh, HTML escape; disabled/untrusted do not open pages", async (t) => {
  const f = await fixture(t);
  const card = await f.provider.page(cardId("demo"));
  assert(card.rows.flat().some((b) => b.id === sectionId("demo", "home")));
  const page = await f.provider.page(sectionId("demo", "home"));
  assert.equal(page.rows[0][0].id, sectionId("demo", "details"));
  assert(render(page, "0".repeat(24), 0).text.includes("&lt;panel&gt;"));
  assert.equal(
    (await f.provider.page(sectionId("demo", "details"))).title,
    "Details",
  );
  for (const state of [
    { enabled: false, trusted: true },
    { enabled: true, trusted: false },
  ]) {
    await writeFile(
      f.registry,
      JSON.stringify({ plugins: [{ name: "demo", ...state }] }),
    );
    const denied = await f.provider.page(sectionId("demo", "details"));
    assert.equal(denied.title, "demo");
    assert(!denied.rows.flat().some((b) => b.id.startsWith("panel:")));
  }
});
test("bad definitions/version/cross-targets/commands fall back to card without poisoning catalog", async (t) => {
  const f = await fixture(t);
  const malformed = [
    { ...definition, schema: "iva-panels/v2" },
    { ...definition, plugin: "other" },
    { ...definition, pluginVersion: "2.0.0" },
    { ...definition, entry: "missing" },
    { ...definition, pages: [definition.pages[0], definition.pages[0]] },
    {
      ...definition,
      pages: [
        {
          ...definition.pages[0],
          rows: [[{ label: "Escape", target: "bitrix:actions" }]],
        },
      ],
    },
    {
      ...definition,
      pages: [
        {
          ...definition.pages[0],
          rows: [[{ label: "Exec", target: "home", command: "synthetic" }]],
        },
      ],
    },
    {
      ...definition,
      pages: [
        { ...definition.pages[0], body: "&".repeat(1500) },
        definition.pages[1],
      ],
    },
  ];
  for (const d of malformed) {
    await writeFile(f.panels, JSON.stringify(d));
    const card = await f.provider.page(cardId("demo"));
    assert(!card.rows.flat().some((b) => b.id.startsWith("panel:")));
    assert.match((await f.provider.page("home")).body, /Установлено: 1/);
  }
  assert(panelDefinitionSchema.safeParse(definition).success);
  await writeFile(f.panels, "x".repeat(32769));
  assert.equal(
    (await f.provider.page(sectionId("demo", "home"))).title,
    "demo",
  );
  await rm(f.panels);
  await symlink(join(f.data, "custom/plugins/demo/plugin.json"), f.panels);
  assert.equal(
    (await f.provider.page(sectionId("demo", "home"))).title,
    "demo",
  );
});
test("invalid registry names and duplicate entries refused, never used as filesystem paths", async (t) => {
  const f = await fixture(t);
  for (const names of [["../demo"], ["demo", "demo"], ["a--b"], ["a..b"]]) {
    await writeFile(
      f.registry,
      JSON.stringify({
        plugins: names.map((name) => ({ name, enabled: true, trusted: true })),
      }),
    );
    await assert.rejects(f.provider.page("home"));
  }
});

test("optional version metadata cannot poison discovery; build suffix supported", async (t) => {
  const f = await fixture(t);
  await writeFile(
    f.registry,
    JSON.stringify({
      plugins: [
        {
          name: "demo",
          enabled: true,
          trusted: true,
          version: { unexpected: true },
        },
      ],
    }),
  );
  assert.match((await f.provider.page("home")).body, /Установлено: 1/);
  await writeFile(
    join(f.data, "custom/plugins/demo/plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0+build.2" }),
  );
  await writeFile(
    f.panels,
    JSON.stringify({ ...definition, pluginVersion: "1.0.0+build.2" }),
  );
  assert.equal(
    (await f.provider.page(sectionId("demo", "home"))).title,
    "Demo <panel>",
  );
});
