import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readFile,
  chmod,
  symlink,
  realpath,
} from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  DynamicPanels,
  socketCall,
  dynamicReadId,
  validateDynamicDefinition,
  type DynamicCall,
} from "../plugin/sh.iva/services/router/dynamic.ts";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
import { pluginKey, cardId } from "../plugin/sh.iva/services/router/catalog.ts";
import { render } from "../plugin/sh.iva/services/router/contracts.ts";
import { Engine } from "../plugin/sh.iva/services/router/engine.ts";
import { Store } from "../plugin/sh.iva/services/router/store.ts";
// @ts-expect-error Dependency-free distributable helper is JavaScript.
import { serveSettings } from "../plugin/skills/iva-panels-integration/resources/settings-service.mjs";
const name = "dynamic-demo";
const descriptor = {
  schema: "iva-panels/v2",
  plugin: name,
  pluginVersion: "1.0.0",
  entry: "home",
  capabilities: ["settings"],
};
const entry = { name, enabled: true, trusted: true, sha: "a".repeat(40) };
async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  supplied?: DynamicCall,
) {
  const data = await realpath(await mkdtemp("/tmp/pd-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "custom/plugins", name),
    directory = join(data, "plugin-data", name),
    panelsData = join(data, "plugin-data/iva-panels");
  await mkdir(root, { recursive: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  await writeFile(join(root, "panels.json"), JSON.stringify(descriptor));
  const registry = join(data, "custom/plugins.json");
  await writeFile(registry, JSON.stringify({ plugins: [entry] }));
  const options = {
    name,
    version: "1.0.0",
    directory,
    defaults: { compact: false },
    validate(v: { compact: boolean }) {
      assert.equal(typeof v.compact, "boolean");
      return { compact: v.compact };
    },
    screen(page: string, settings: { compact: boolean }) {
      assert.equal(page, "home");
      return {
        title: "Demo <settings>",
        body: `Compact: ${settings.compact}`,
        rows: [[{ label: "Toggle", action: "toggle" }]],
      };
    },
    propose(action: string, settings: { compact: boolean }) {
      assert.equal(action, "toggle");
      return {
        summary: "Compact: false → true",
        settings: { compact: !settings.compact },
      };
    },
  };
  let server = await serveSettings(options);
  t.after(() => new Promise<void>((resolve) => server.close(resolve)));
  const call = supplied ?? socketCall(data);
  const dynamic = new DynamicPanels(data, panelsData, call);
  const provider = installedPanels(
    data,
    false,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    dynamic,
  );
  return {
    data,
    root,
    directory,
    panelsData,
    registry,
    call,
    dynamic,
    provider,
    restart: async () => {
      await new Promise<void>((r) => server.close(r));
      server = await serveSettings(options);
    },
    state: async () =>
      JSON.parse(
        await readFile(join(directory, "panels-settings.json"), "utf8"),
      ),
  };
}
test("real socket: discover API, read, prepare without change, cancel, confirm once, persistent receipt", async (t) => {
  const f = await fixture(t);
  const card = await f.provider.page(cardId(name));
  assert.match(card.body, /объявлен API/);
  assert(card.rows.flat().some((b) => b.id === dynamicReadId(name, "home")));
  const read = await f.provider.page(dynamicReadId(name, "home"));
  assert.match(render(read, "0".repeat(24), 0).text, /&lt;settings&gt;/);
  const offer = await f.provider.page(read.rows[0][0].id);
  assert.equal((await f.state()).settings.compact, false);
  const cancel = offer.rows[0][1].id;
  await f.provider.page(cancel);
  assert.equal((await f.state()).settings.compact, false);
  const next = await f.provider.page(read.rows[0][0].id);
  const confirm = next.rows[0][0].id;
  assert(f.provider.isMutation!(confirm));
  assert.match((await f.provider.page(confirm)).body, /сохранены/);
  assert.equal((await f.state()).revision, 1);
  await f.provider.page(confirm);
  await f.restart();
  assert.equal(
    (
      (await f.call(name, "1.0.0", {
        op: "confirm",
        token: confirm.split(":")[3],
      })) as { state: string }
    ).state,
    "done",
  );
  const restarted = new DynamicPanels(f.data, f.panelsData);
  await restarted.page(
    confirm,
    entry,
    validateDynamicDefinition(descriptor, name, "1.0.0"),
  );
  assert.equal((await f.state()).revision, 1);
  assert.match(
    (await f.provider.page(`connect:${pluginKey(name)}`)).body,
    /iva-panels-integration/,
  );
});
test("lost confirm response and router restart: status reconciles without replay; pending blocks new changes", async (t) => {
  const f = await fixture(t);
  const calls: string[] = [];
  const dynamic = new DynamicPanels(f.data, f.panelsData, async (n, v, req) => {
    calls.push(req.op);
    const result = await f.call(n, v, req);
    if (req.op === "confirm") throw new Error("LOST_RESPONSE");
    return result;
  });
  const d = validateDynamicDefinition(descriptor, name, "1.0.0");
  const read = await dynamic.page(dynamicReadId(name, "home"), entry, d);
  const offer = await dynamic.page(read.rows[0][0].id, entry, d);
  const confirm = offer.rows[0][0].id;
  const uncertain = await dynamic.page(confirm, entry, d);
  assert.match(uncertain.body, /Повторного/);
  await dynamic.page(confirm, entry, d);
  await dynamic.page(read.rows[0][0].id, entry, d);
  assert.equal(calls.filter((s) => s === "confirm").length, 1);
  const restarted = new DynamicPanels(
    f.data,
    f.panelsData,
    async (n, v, req) => {
      calls.push(req.op);
      return f.call(n, v, req);
    },
  );
  assert.match(
    (await restarted.page(uncertain.rows[0][0].id, entry, d)).body,
    /сохранены/,
  );
  assert.equal((await f.state()).revision, 1);
  assert.equal(calls.filter((s) => s === "confirm").length, 1);
});
test("identity, registry fingerprint, expiry, stale revision and disabled/untrusted guard effects", async (t) => {
  const f = await fixture(t);
  const read = await f.provider.page(dynamicReadId(name, "home"));
  const offer = await f.provider.page(read.rows[0][0].id);
  await writeFile(
    f.registry,
    JSON.stringify({ plugins: [{ ...entry, sha: "b".repeat(40) }] }),
  );
  assert.match((await f.provider.page(offer.rows[0][0].id)).body, /изменились/);
  assert.equal((await f.state()).revision, 0);
  for (const state of [
    { enabled: false, trusted: true },
    { enabled: true, trusted: false },
  ]) {
    await writeFile(
      f.registry,
      JSON.stringify({ plugins: [{ ...entry, ...state }] }),
    );
    assert.match(
      (await f.provider.page(offer.rows[0][0].id)).body,
      /недоступна/,
    );
  }
  await writeFile(f.registry, JSON.stringify({ plugins: [entry] }));
  const d = validateDynamicDefinition(descriptor, name, "1.0.0");
  const expired = new DynamicPanels(
    f.data,
    f.panelsData,
    f.call,
    () => Date.now() + 20 * 60000,
  );
  assert.match(
    (await expired.page(offer.rows[0][0].id, entry, d)).body,
    /истёк/,
  );
  await f.provider.page(offer.rows[0][1].id);
  await assert.rejects(f.call(name, "wrong", { op: "read", page: "home" }));
  assert.equal(
    (
      (await f.call(name, "1.0.0", {
        op: "prepare",
        action: "toggle",
        revision: 8,
        token: "c".repeat(24),
      })) as { state: string }
    ).state,
    "rejected",
  );
  await writeFile(
    join(f.root, "panels.json"),
    JSON.stringify({ ...descriptor, pluginVersion: "2.0.0" }),
  );
  assert.match((await f.provider.page(cardId(name))).body, /несовместимо/);
});
test("invalid endpoint permissions, symlink and oversized/malicious response fail closed", async (t) => {
  const f = await fixture(t);
  const socket = join(f.directory, "panels.sock");
  await chmod(socket, 0o666);
  await assert.rejects(f.call(name, "1.0.0", { op: "read", page: "home" }));
  await chmod(socket, 0o600);
  const d = validateDynamicDefinition(descriptor, name, "1.0.0");
  for (const response of [
    {
      state: "screen",
      revision: 0,
      title: "Unsafe",
      body: "",
      rows: [[{ label: "Shell", command: "sh", action: "exec" }]],
    },
    {
      state: "screen",
      revision: 0,
      title: "Oversized",
      body: "&".repeat(1500),
      rows: [],
    },
  ]) {
    const provider = new DynamicPanels(
      f.data,
      f.panelsData,
      async () => response,
    );
    assert.match(
      (await provider.page(dynamicReadId(name, "home"), entry, d)).body,
      /несовместимый/,
    );
  }
  const malicious = join(f.data, "oversized.sock");
  const server = createServer((_req, res) => res.end("x".repeat(40000)));
  await new Promise<void>((r) => server.listen(malicious, r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const extraName = "oversized";
  await mkdir(join(f.data, "plugin-data", extraName));
  await symlink(
    malicious,
    join(f.data, "plugin-data", extraName, "panels.sock"),
  );
  await assert.rejects(
    f.call(extraName, "1.0.0", { op: "read", page: "home" }),
  );
});
test("engine persists acting, rejects alien/stale taps and retries only saved delivery after settings effect", async (t) => {
  const f = await fixture(t);
  const store = new Store(f.panelsData);
  let fail = false;
  const engine = new Engine(store, f.provider, {
    send: async () => 123,
    edit: async () => {
      if (fail) throw new Error("DELIVERY_LOST");
    },
  });
  let update = 1;
  const event = (text: string, owner = 42) => ({
    update_id: update++,
    message: {
      message_id: 123,
      from: { id: owner, is_bot: false as const },
      chat: { id: 42, type: "private" as const },
      text,
    },
  });
  await engine.handle(event("/panels"));
  async function tap(find: (id: string) => boolean, owner = 42) {
    const state = await store.load(),
      [id, screen] = Object.entries(state.screens)[0];
    const index = screen.view.rows.flat().findIndex((b) => find(b.id));
    assert(index >= 0);
    const e = event(`iva_panels:${id}:${screen.revision}:${index}`, owner);
    await engine.handle(e);
    return e;
  }
  await tap((id) => id === cardId(name));
  await tap((id) => id.startsWith("dyn:read:"));
  await tap((id) => id.startsWith("dyn:prepare:"));
  await tap((id) => id.startsWith("dyn:confirm:"), 999);
  assert.equal((await f.state()).revision, 0);
  fail = true;
  const state = await store.load(),
    [id, screen] = Object.entries(state.screens)[0];
  const confirm = event(`iva_panels:${id}:${screen.revision}:0`);
  await assert.rejects(engine.handle(confirm));
  assert.equal((await f.state()).revision, 1);
  fail = false;
  await new Engine(store, f.provider, {
    send: async () => 123,
    edit: async () => {},
  }).handle(confirm);
  await engine.handle(event(confirm.message.text));
  assert.equal((await f.state()).revision, 1);
});
test("v2 rejects commands/endpoints, valid v1 and missing connection keep base discovery", async (t) => {
  for (const bad of [
    { ...descriptor, url: "http://127.0.0.1" },
    { ...descriptor, plugin: "other" },
    { ...descriptor, capabilities: ["settings", "settings"] },
  ])
    assert.throws(() => validateDynamicDefinition(bad, name, "1.0.0"));
  const f = await fixture(t);
  await rm(join(f.root, "panels.json"));
  assert.match(
    (await f.provider.page(cardId(name))).body,
    /общий API не подключён/,
  );
  assert.match(
    (await f.provider.page(`connect:${pluginKey(name)}`)).body,
    /Подключи плагин/,
  );
  assert.match(
    (await installedPanels(f.data).page(`connect:${pluginKey(name)}`)).body,
    /выключен оператором/,
  );
});

test("definite stale prepare rejection allows a fresh choice without uncertain lock", async (t) => {
  const f = await fixture(t);
  const d = validateDynamicDefinition(descriptor, name, "1.0.0");
  const page = await f.dynamic.page(
    `dyn:prepare:${pluginKey(name)}:8:toggle`,
    entry,
    d,
  );
  assert.match(page.body, /Настройки изменились/);
  const fresh = await f.dynamic.page(dynamicReadId(name, "home"), entry, d);
  assert.match(fresh.body, /Compact/);
  const offer = await f.dynamic.page(fresh.rows[0][0].id, entry, d);
  assert.equal(offer.rows[0][0].label, "Подтвердить");
});

test("SDK resources and example stay consistent; durable journal precedes plugin call", async (t) => {
  for (const [source, resource] of [
    [
      "../examples/dynamic-notes/sh.iva/services/panels/server.mjs",
      "../plugin/skills/iva-panels-integration/resources/example-server.mjs",
    ],
    [
      "../docs/DYNAMIC_API.md",
      "../plugin/skills/iva-panels-integration/resources/CONTRACT.md",
    ],
    [
      "../docs/CHAT_CARDS.md",
      "../plugin/skills/iva-panels-integration/resources/CHAT_CARDS.md",
    ],
  ]) {
    const content = async (path: string) =>
      (await readFile(new URL(path, import.meta.url), "utf8")).replace(
        /\]\([^)]*\)/g,
        "]",
      );
    assert.equal(
      await content(source),
      await content(resource),
      `Installed SDK differs: ${resource}`,
    );
  }

  assert.equal(
    await readFile(
      new URL("../docs/panels-v2.schema.json", import.meta.url),
      "utf8",
    ),
    await readFile(
      new URL(
        "../plugin/skills/iva-panels-integration/resources/panels-v2.schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(
    await readFile(
      new URL(
        "../examples/dynamic-notes/sh.iva/services/panels/settings-service.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
    await readFile(
      new URL(
        "../plugin/skills/iva-panels-integration/resources/settings-service.mjs",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const f = await fixture(t);
  const dynamic = new DynamicPanels(f.data, f.panelsData, async (n, v, req) => {
    if (req.op === "prepare" || req.op === "confirm" || req.op === "cancel") {
      const journal = JSON.parse(
        await readFile(join(f.panelsData, "dynamic-jobs.json"), "utf8"),
      );
      assert.equal(journal[pluginKey(name)].token, req.token);
      assert.equal(
        journal[pluginKey(name)].phase,
        req.op === "prepare"
          ? "preparing"
          : req.op === "confirm"
            ? "confirming"
            : "cancelling",
      );
    }
    return f.call(n, v, req);
  });
  const d = validateDynamicDefinition(descriptor, name, "1.0.0");
  const read = await dynamic.page(dynamicReadId(name, "home"), entry, d);
  const offer = await dynamic.page(read.rows[0][0].id, entry, d);
  await dynamic.page(offer.rows[0][0].id, entry, d);
  assert.equal((await f.state()).revision, 1);
});

test("card distinguishes settings-only, actions-only and combined capabilities", async (t) => {
  const f = await fixture(t);
  for (const [capabilities, label] of [
    [["settings"], "Настройки"],
    [["actions"], "Действия плагина"],
    [["settings", "actions"], "Настройки и действия"],
  ] as const) {
    await writeFile(
      join(f.root, "panels.json"),
      JSON.stringify({ ...descriptor, capabilities }),
    );
    const card = await f.provider.page(cardId(name));
    assert.equal(
      card.rows.flat().find((b) => b.id.startsWith("dyn:read:"))?.label,
      label,
    );
    assert(!card.body.includes("Дополнительные разделы не подключены"));
  }
});

test("plugin navigation to entry does not duplicate the Router entry action", async (t) => {
  const f = await fixture(t, async () => ({
    state: "screen",
    revision: 0,
    title: "Plugin settings",
    body: "Own home navigation",
    rows: [[{ label: "Back to settings", target: "home" }]],
  }));
  const view = await f.provider.page(dynamicReadId(name, "home"));
  assert.equal(view.body, "Own home navigation");
  assert.equal(
    view.rows
      .flat()
      .filter((button) => button.id === dynamicReadId(name, "home")).length,
    1,
  );
  assert(
    view.rows.flat().some((button) => button.label === "Back to settings"),
  );
});
