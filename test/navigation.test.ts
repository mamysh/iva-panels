import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
import { pluginKey, cardId } from "../plugin/sh.iva/services/router/catalog.ts";
import {
  DynamicPanels,
  type DynamicRequest,
} from "../plugin/sh.iva/services/router/dynamic.ts";
import { inspectIntegration } from "../plugin/sh.iva/services/router/integration.ts";
import {
  panelCommand,
  owns,
  render,
} from "../plugin/sh.iva/services/router/contracts.ts";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const data = await mkdtemp(join(tmpdir(), "panel-nav-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const entries = ["notes", "iva-panels", "off"].map((name) => ({
    name,
    enabled: name !== "off",
    trusted: true,
  }));
  for (const p of entries) {
    await mkdir(join(data, "custom/plugins", p.name), { recursive: true });
    await writeFile(
      join(data, "custom/plugins", p.name, "plugin.json"),
      JSON.stringify({ name: p.name, version: "1.0.0" }),
    );
  }
  await writeFile(
    join(data, "custom/plugins.json"),
    JSON.stringify({ plugins: entries }),
  );
  const descriptor = {
    schema: "iva-panels/v2",
    plugin: "notes",
    pluginVersion: "1.0.0",
    entry: "home",
    capabilities: ["settings"],
  };
  const path = join(data, "custom/plugins/notes/panels.json");
  await writeFile(path, JSON.stringify(descriptor));
  return { data, path, descriptor };
}
test("main path opens live settings in one click; details stay secondary; own Panels never suggests self integration", async (t) => {
  const f = await fixture(t);
  const operations: DynamicRequest[] = [];
  const provider = installedPanels(
    f.data,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    new DynamicPanels(
      f.data,
      join(f.data, "plugin-data/iva-panels"),
      async (_n, _v, op) => {
        operations.push(op);
        return {
          state: "screen",
          revision: 0,
          title: "Notes settings",
          body: "Current values",
          rows: [],
        };
      },
    ),
  );
  const home = await provider.page("home");
  assert.equal(operations.length, 0, "catalog must not call every plugin API");
  const first = await provider.page(home.rows[0][0].id);
  assert.equal(first.title, "Notes settings");
  assert.deepEqual(operations, [{ op: "read", page: "home" }]);
  assert(first.rows.flat().some((b) => b.id === "home"));
  const info = await provider.page(home.rows[0][1].id);
  assert.equal(info.title, "notes");
  for (const id of [
    cardId("iva-panels"),
    `open:${pluginKey("iva-panels")}`,
    `connect:${pluginKey("iva-panels")}`,
  ]) {
    const own = await provider.page(id);
    assert.equal(own.title, "Panels · Состояние");
    assert(!own.rows.flat().some((b) => b.id.startsWith("connect:")));
    assert(!own.body.includes("Подключи плагин iva-panels"));
    render(own, "0".repeat(24), 0);
  }
  assert.equal((await provider.page(`open:${pluginKey("off")}`)).title, "off");
  assert.match((await provider.page("help")).body, /не подтверждение/);
  render(home, "0".repeat(24), 0);
});
test("inspection identifies the actual blocker and probes read only; no plugin screen content escapes", async (t) => {
  const f = await fixture(t);
  const ops: DynamicRequest[] = [];
  const read = async (_n: string, _v: string, op: DynamicRequest) => {
    ops.push(op);
    return {
      state: "screen",
      revision: 0,
      title: "private title",
      body: "private data",
      rows: [],
    };
  };
  const ready = await inspectIntegration(f.data, "notes", true, read);
  assert.equal(ready.state, "ready");
  assert.deepEqual(ops, [{ op: "read", page: "home" }]);
  assert(!JSON.stringify(ready).includes("private"));
  assert.equal(
    (await inspectIntegration(f.data, "notes", false, read)).state,
    "disabled",
  );
  assert.equal(ops.length, 1, "disabled API must not be contacted");
  assert.equal(
    (await inspectIntegration(f.data, "iva-panels", true, read)).state,
    "builtin",
  );
  assert.equal(
    (await inspectIntegration(f.data, "off", true, read)).state,
    "paused",
  );
  assert.equal(
    (await inspectIntegration(f.data, "unknown", true, read)).state,
    "not-installed",
  );
  assert.equal(
    (
      await inspectIntegration(f.data, "notes", true, async () => {
        throw new Error("private error");
      })
    ).state,
    "unavailable",
  );
  await writeFile(
    f.path,
    JSON.stringify({ ...f.descriptor, pluginVersion: "2.0.0" }),
  );
  assert.equal(
    (await inspectIntegration(f.data, "notes", true, read)).state,
    "invalid",
  );
  await rm(f.path);
  assert.equal(
    (await inspectIntegration(f.data, "notes", true, read)).state,
    "missing",
  );
  await assert.rejects(inspectIntegration(f.data, "../private", true, read));
});
test("explicit command aliases and plugin shortcuts; ordinary prose and stock callbacks remain outside Panels", () => {
  for (const text of ["/panels", "/ panels", "/panels  "]) {
    assert.equal(panelCommand(text), "");
    assert(owns(text));
  }
  assert.equal(panelCommand("/panels notes"), "notes");
  for (const text of [
    "открой панели",
    "В задачи: пример",
    "iva_task:31",
    "/panels ../notes",
    "/panels a--b",
    "/panels a..b",
    "/panels notes confirm",
    "/panels@otherbot",
  ]) {
    assert.equal(panelCommand(text), undefined);
    assert(!owns(text));
  }
});
