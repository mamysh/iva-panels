import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  Lifecycle,
  readJob,
  saveJob,
  fingerprint,
  registered,
} from "../plugin/sh.iva/services/router/lifecycle.ts";
import {
  runJob,
  lifecycleUnits,
  unitsHealthy,
} from "../plugin/sh.iva/services/router/lifecycle-worker.ts";
import { pluginKey, cardId } from "../plugin/sh.iva/services/router/catalog.ts";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
import {
  render,
  configSchema,
} from "../plugin/sh.iva/services/router/contracts.ts";
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "panels-lifecycle-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = join(root, "data"),
    panels = join(root, "panels"),
    cli = join(root, "iva.mjs");
  await mkdir(join(data, "custom/plugins/demo"), { recursive: true });
  await mkdir(panels, { mode: 0o700 });
  const registry = join(data, "custom/plugins.json"),
    entry = {
      name: "demo",
      enabled: true,
      trusted: true,
      sha: "a".repeat(40),
      source: "synthetic",
    };
  await writeFile(registry, JSON.stringify({ plugins: [entry] }));
  await writeFile(
    join(data, "custom/plugins/demo/plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  );
  const config = {
    upstream: "http://127.0.0.1:9000",
    secret: "synthetic-secret-123",
    botToken: "123:synthetic",
    owners: [42],
    lifecycle: { cli },
  };
  await writeFile(join(panels, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  const script = `import {readFile,writeFile,unlink,symlink} from 'node:fs/promises';import {join,dirname} from 'node:path';if(process.env.TELEGRAM_BOT_TOKEN)throw new Error('Unexpected bot env');const data=process.env.ASSISTANT_DATA_DIR;const path=join(data,'custom/plugins.json');const state=JSON.parse(await readFile(path,'utf8'));state.plugins.find(p=>p.name===process.argv[4]).enabled=process.argv[3]==='enable';await writeFile(path,JSON.stringify(state));const link=join(dirname(data),'iva.mjs');await unlink(link);await symlink(join(dirname(data),'native-after.mjs'),link);`;
  await writeFile(join(root, "native-before.mjs"), script);
  await writeFile(join(root, "native-after.mjs"), script);
  await symlink(join(root, "native-before.mjs"), cli);
  return {
    root,
    data,
    panels,
    cli,
    config,
    registry,
    entry,
    key: pluginKey("demo"),
  };
}
function jobId(page: { rows: { id: string }[][] }) {
  return page.rows
    .flat()
    .find((b) => b.id.startsWith("life:confirm:"))!
    .id.slice(13);
}
test("preview/cancel/private persistence never invoke manager; opt-in and protected self", async (t) => {
  const f = await fixture(t);
  let launched = 0;
  const life = new Lifecycle(f.data, f.panels, { cli: f.cli }, async () => {
    launched++;
  });
  const preview = await life.page(`life:prepare:${f.key}:disable`),
    id = jobId(preview);
  render(preview, "0".repeat(24), 1);
  assert.equal((await readJob(life.dir, id)).phase, "preview");
  assert.equal((await registered(f.data))[0].enabled, true);
  await life.page(`life:cancel:${id}`);
  await life.page(`life:confirm:${id}`);
  assert.equal(launched, 0);
  const provider = installedPanels(
    f.data,
    false,
    undefined,
    false,
    undefined,
    undefined,
    life,
  );
  assert(
    (await provider.page(cardId("demo"))).rows
      .flat()
      .some((b) => b.label === "Управление плагином"),
  );
  assert(
    (await installedPanels(f.data).page(`life:open:${f.key}`)).body.includes(
      "не настроено",
    ),
  );
  await writeFile(
    f.registry,
    JSON.stringify({ plugins: [{ ...f.entry, name: "iva-panels" }] }),
  );
  assert(
    (
      await life.page(`life:prepare:${pluginKey("iva-panels")}:disable`)
    ).body.includes("заблокировано"),
  );
  assert.equal(launched, 0);
});
test("expired/replaced state, removed trust and source changes refuse confirmation", async (t) => {
  const f = await fixture(t);
  let now = Date.now(),
    launched = 0;
  const life = new Lifecycle(
    f.data,
    f.panels,
    { cli: f.cli },
    async () => {
      launched++;
    },
    () => now,
  );
  for (const altered of [
    { ...f.entry, sha: "b".repeat(40) },
    { ...f.entry, source: "changed" },
    { ...f.entry, trusted: false },
    { ...f.entry, enabled: false },
  ]) {
    await writeFile(f.registry, JSON.stringify({ plugins: [f.entry] }));
    const id = jobId(await life.page(`life:prepare:${f.key}:disable`));
    await writeFile(f.registry, JSON.stringify({ plugins: [altered] }));
    await life.page(`life:confirm:${id}`);
    assert.equal((await readJob(life.dir, id)).phase, "failed");
  }
  await writeFile(f.registry, JSON.stringify({ plugins: [f.entry] }));
  const id = jobId(await life.page(`life:prepare:${f.key}:disable`));
  now += 900001;
  await life.page(`life:confirm:${id}`);
  assert.equal((await readJob(life.dir, id)).phase, "failed");
  assert.equal(launched, 0);
});
test("queued launch is durable, duplicate/recovery never launch twice, global busy and unknown launch fail safely", async (t) => {
  const f = await fixture(t);
  let launched = 0;
  const life: Lifecycle = new Lifecycle(
    f.data,
    f.panels,
    { cli: f.cli },
    async (id) => {
      launched++;
      assert.equal((await readJob(life.dir, id)).phase, "queued");
    },
  );
  const a = jobId(await life.page(`life:prepare:${f.key}:disable`)),
    b = jobId(await life.page(`life:prepare:${f.key}:disable`));
  await life.page(`life:confirm:${a}`);
  await life.page(`life:confirm:${a}`);
  await life.recover(`life:confirm:${a}`);
  await life.page(`life:confirm:${b}`);
  assert.equal(launched, 1);
  const old = await readJob(life.dir, a);
  old.phase = "uncertain";
  await saveJob(life.dir, old);
  const failing = new Lifecycle(f.data, f.panels, { cli: f.cli }, async () => {
    launched++;
    throw new Error("synthetic secret");
  });
  const page = await failing.page(`life:confirm:${b}`);
  assert.doesNotMatch(page.body, /secret/);
  assert.equal((await readJob(life.dir, b)).phase, "uncertain");
  await failing.page(`life:confirm:${b}`);
  assert.equal(launched, 2);
});
test("worker uses separate real CLI process with scoped env; verifies state/rebuild/health and never replays", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.data, "custom/plugins/demo/mcp.json"), "{}");
  const life = new Lifecycle(f.data, f.panels, { cli: f.cli }, (id) =>
    runJob(f.data, f.panels, id, undefined, async () => true),
  );
  const id = jobId(await life.page(`life:prepare:${f.key}:disable`));
  await life.page(`life:confirm:${id}`);
  assert.equal((await readJob(life.dir, id)).phase, "done");
  assert.equal((await registered(f.data))[0].enabled, false);
  let replay = 0;
  await runJob(
    f.data,
    f.panels,
    id,
    async () => {
      replay++;
      return 0;
    },
    async () => true,
  );
  assert.equal(replay, 0);
  assert(
    (await life.page(`life:open:${f.key}`)).rows
      .flat()
      .some((b) => b.label === "Последняя задача"),
  );
  const next = jobId(await life.page(`life:prepare:${f.key}:enable`));
  await life.page(`life:confirm:${next}`);
  // Fixture's second CLI does not flip the version link: registration alone cannot prove rebuild.
  assert.equal((await readJob(life.dir, next)).phase, "uncertain");
});
test("worker checks snapshot again; errors/health failures are uncertain and running crash is never replayed", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const life = new Lifecycle(f.data, f.panels, { cli: f.cli }, async () => {});
  const id = jobId(await life.page(`life:prepare:${f.key}:disable`));
  await life.page(`life:confirm:${id}`);
  await writeFile(
    f.registry,
    JSON.stringify({ plugins: [{ ...f.entry, sha: "b".repeat(40) }] }),
  );
  await runJob(
    f.data,
    f.panels,
    id,
    async () => {
      calls++;
      return 0;
    },
    async () => true,
  );
  assert.equal(calls, 0);
  assert.equal((await readJob(life.dir, id)).phase, "failed");
  await writeFile(f.registry, JSON.stringify({ plugins: [f.entry] }));
  const second = jobId(await life.page(`life:prepare:${f.key}:disable`));
  await life.page(`life:confirm:${second}`);
  await runJob(
    f.data,
    f.panels,
    second,
    async () => {
      calls++;
      throw new Error("synthetic failure");
    },
    async () => true,
  );
  assert.equal((await readJob(life.dir, second)).phase, "uncertain");
  const job = await readJob(life.dir, second);
  job.phase = "running";
  job.started = Date.now() - 17 * 60_000;
  await saveJob(life.dir, job);
  await runJob(
    f.data,
    f.panels,
    second,
    async () => {
      calls++;
      return 0;
    },
    async () => true,
  );
  assert.equal(calls, 1);
  assert(
    (await life.page(`life:status:${second}`)).body.includes("ожидаемый срок"),
  );
});
test("config rejects shell/relative manager paths and worker job files stay private", async (t) => {
  const f = await fixture(t);
  for (const cli of [
    "iva",
    "./iva.mjs",
    "/tmp/iva.mjs\0",
    "/tmp/not-manager.sh",
  ]) {
    assert(
      !configSchema.safeParse({ ...f.config, lifecycle: { cli } }).success,
    );
  }
  const life = new Lifecycle(f.data, f.panels, { cli: f.cli }, async () => {});
  const id = jobId(await life.page(`life:prepare:${f.key}:disable`));
  const { stat } = await import("node:fs/promises");
  assert.equal((await stat(join(life.dir, id + ".json"))).mode & 0o077, 0);
  assert.equal((await readdir(life.dir)).length, 1);
  assert.equal(fingerprint(f.entry), (await readJob(life.dir, id)).fingerprint);
});

test("systemd launcher isolates credentials and uses one bounded detached unit with argument array", async (t) => {
  const f = await fixture(t);
  const dir = join(f.root, "bin"),
    capture = join(f.root, "launch.json");
  await mkdir(dir);
  await symlink(process.execPath, join(dir, "node"));
  await writeFile(
    join(dir, "systemd-run"),
    `#!/usr/bin/env node\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),botPresent:Boolean(process.env.TELEGRAM_BOT_TOKEN)}));\n`,
    { mode: 0o700 },
  );
  const originalPath = process.env.PATH,
    originalBot = process.env.TELEGRAM_BOT_TOKEN;
  try {
    process.env.PATH = dir + ":" + originalPath;
    process.env.TELEGRAM_BOT_TOKEN = "123:synthetic";
    const { systemdLaunch } =
      await import("../plugin/sh.iva/services/router/lifecycle.ts");
    await systemdLaunch(
      f.data,
      f.panels,
    )("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
    const { readFile } = await import("node:fs/promises");
    const result = JSON.parse(await readFile(capture, "utf8"));
    assert.equal(result.botPresent, false);
    assert(result.args.includes("--unit=iva-panels-lifecycle"));
    assert(result.args.includes("--property=RuntimeMaxSec=900"));
    assert(result.args.includes(f.data));
    assert(result.args.includes(f.panels));
    await assert.rejects(systemdLaunch(f.data, f.panels)("../../bad"));
  } finally {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalBot === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalBot;
  }
});

test("local digest pins previews; unpinned installs refuse controls", async (t) => {
  const f = await fixture(t);
  const life = new Lifecycle(f.data, f.panels, { cli: f.cli }, async () => {});
  const local = { ...f.entry, sha: undefined, digest: "c".repeat(64) };
  await writeFile(f.registry, JSON.stringify({ plugins: [local] }));
  const id = jobId(await life.page(`life:prepare:${f.key}:disable`));
  await writeFile(
    f.registry,
    JSON.stringify({ plugins: [{ ...local, digest: "d".repeat(64) }] }),
  );
  await life.page(`life:confirm:${id}`);
  assert.equal((await readJob(life.dir, id)).phase, "failed");
  await writeFile(
    f.registry,
    JSON.stringify({ plugins: [{ ...local, digest: "" }] }),
  );
  assert.equal(
    (await life.page(`life:prepare:${f.key}:disable`)).rows
      .flat()
      .some((b) => b.id.startsWith("life:confirm:")),
    false,
  );
});
test("successful native exit and registry change cannot hide failed plugin units", async (t) => {
  const f = await fixture(t);
  const life = new Lifecycle(f.data, f.panels, { cli: f.cli }, async () => {});
  assert.deepEqual(
    lifecycleUnits({
      ...f.entry,
      mcp: { api: { port: 1 } },
      services: { router: { port: 2 } },
    }),
    ["iva-mcp-demo-api.service", "iva-plugin-demo-router.service"],
  );
  for (const map of [{ "--malicious": {} }, [], { ["a".repeat(65)]: {} }])
    assert.throws(() => lifecycleUnits({ ...f.entry, services: map }));
  assert.equal(await unitsHealthy(f.entry, true), true);
  const id = jobId(await life.page(`life:prepare:${f.key}:disable`));
  await life.page(`life:confirm:${id}`);
  await runJob(
    f.data,
    f.panels,
    id,
    undefined,
    async () => true,
    async (entry, target) => {
      assert.equal(entry.enabled, false);
      assert.equal(target, false);
      return false;
    },
  );
  assert.equal((await readJob(life.dir, id)).phase, "uncertain");
});
test("unit checker requires exact ActiveState and treats unavailable or failed units as unconfirmed", async (t) => {
  const f = await fixture(t);
  const bin = join(f.root, "unit-bin");
  await mkdir(bin);
  await symlink(process.execPath, join(bin, "node"));
  const tool = join(bin, "systemctl");
  const original = process.env.PATH;
  process.env.PATH = bin;
  try {
    const entry = { ...f.entry, services: { router: { port: 1 } } };
    for (const [state, target, expected] of [
      ["active", true, true],
      ["inactive", false, true],
      ["failed", false, false],
      ["active", false, false],
    ] as const) {
      await writeFile(
        tool,
        `#!/usr/bin/env node\nimport assert from 'node:assert/strict';assert.deepEqual(process.argv.slice(2),['--user','show','iva-plugin-demo-router.service','--property=ActiveState','--value']);console.log('${state}');`,
        { mode: 0o700 },
      );
      assert.equal(await unitsHealthy(entry, target), expected);
    }
    await writeFile(tool, "#!/usr/bin/env node\nprocess.exit(1)", {
      mode: 0o700,
    });
    assert.equal(await unitsHealthy(entry, true), false);
  } finally {
    if (original === undefined) delete process.env.PATH;
    else process.env.PATH = original;
  }
});
