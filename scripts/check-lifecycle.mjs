// Actual stock plugin manager and Panels worker on isolated data.
// systemd, version building and health are synthetic; no live services or network.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  symlink,
  unlink,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  Lifecycle,
  readJob,
  registered,
} from "../plugin/sh.iva/services/router/lifecycle.ts";
import { runJob } from "../plugin/sh.iva/services/router/lifecycle-worker.ts";
import { pluginKey } from "../plugin/sh.iva/services/router/catalog.ts";
const core = process.argv[2];
if (!core) throw new Error("Pass an isolated stock Iva checkout");
const { createPluginCommands } = await import(
  pathToFileURL(join(resolve(core), "scripts/cli/plugin.ts")).href
);
const { createCliRuntime } = await import(
  pathToFileURL(join(resolve(core), "scripts/cli/runtime.ts")).href
);
const root = await mkdtemp(join(tmpdir(), "panels-native-manager-"));
try {
  const data = join(root, "data"),
    panels = join(root, "panels"),
    cli = join(root, "iva.mjs");
  await mkdir(join(data, "custom/plugins/demo"), { recursive: true });
  await mkdir(panels, { mode: 0o700 });
  const entry = {
    name: "demo",
    source: "synthetic",
    ref: "stable",
    sha: "a".repeat(40),
    digest: "",
    enabled: true,
    trusted: true,
    installedAt: "2026-01-01T00:00:00.000Z",
    mcp: { demo: { port: 8730 } },
  };
  await writeFile(
    join(data, "custom/plugins.json"),
    JSON.stringify({ version: 1, marketplaces: [], plugins: [entry] }),
  );
  await writeFile(
    join(data, "custom/plugins/demo/plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "demo",
      version: "1.0.0",
    }),
  );
  await writeFile(
    join(data, "custom/plugins/demo/mcp.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        demo: { type: "stdio", command: "node", args: ["server.mjs"] },
      },
    }),
  );
  await writeFile(
    join(root, "manager-before.mjs"),
    "// isolated manager marker\n",
  );
  await symlink(join(root, "manager-before.mjs"), cli);
  await writeFile(
    join(panels, "config.json"),
    JSON.stringify({
      upstream: "http://127.0.0.1:9000",
      secret: "synthetic-secret-123",
      botToken: "123:synthetic",
      owners: [42],
      lifecycle: { cli },
    }),
    { mode: 0o600 },
  );
  const builds = [],
    effects = [];
  let version = 0;
  let failBuild = false;
  const base = createCliRuntime(root);
  const runtime = {
    ...base,
    dataDirAbs: () => data,
    readEnv: () => ({ ASSISTANT_DATA_DIR: data }),
    hasSystemd: () => false,
    ok: () => {},
    warn: () => {},
    bad: () => {},
    step: () => {},
  };
  const { cmdPlugin } = createPluginCommands(runtime, {
    translate: (en) => en,
    log: () => {},
    buildVersion: async (options) => {
      builds.push(options.requirePlugins);
      if (failBuild)
        return { status: "failed", reason: "Synthetic build failure" };
      const target = join(root, `manager-${++version}.mjs`);
      await writeFile(target, "// isolated build marker\n");
      await unlink(cli);
      await symlink(target, cli);
      return { status: "built", version: `synthetic-${version}` };
    },
  });
  const runner = async (_cli, args, dir) => {
    assert.equal(dir, data);
    effects.push(args);
    await cmdPlugin(args.slice(1));
    return 0;
  };
  const life = new Lifecycle(data, panels, { cli }, (id) =>
    runJob(
      data,
      panels,
      id,
      runner,
      async () => true,
      async () => true,
      async () => true,
      async () => true,
    ),
  );
  const prepare = async (target) => {
    const page = await life.page(`life:prepare:${pluginKey("demo")}:${target}`);
    return page.rows
      .flat()
      .find((b) => b.id.startsWith("life:confirm:"))
      .id.slice(13);
  };
  let id = await prepare("disable");
  await life.page(`life:cancel:${id}`);
  assert.equal(effects.length, 0);
  id = await prepare("disable");
  await life.page(`life:confirm:${id}`);
  assert.equal(
    (await readJob(life.dir, id)).phase,
    "done",
    JSON.stringify({ effects, builds, registry: await registered(data) }),
  );
  assert.equal((await registered(data))[0].enabled, false);
  await life.page(`life:confirm:${id}`);
  await runJob(
    data,
    panels,
    id,
    runner,
    async () => true,
    async () => true,
    async () => true,
    async () => true,
  );
  assert.equal(effects.length, 1);
  id = await prepare("enable");
  await life.page(`life:confirm:${id}`);
  assert.equal((await readJob(life.dir, id)).phase, "done");
  assert.equal((await registered(data))[0].enabled, true);
  assert.deepEqual(effects, [
    ["plugin", "disable", "demo"],
    ["plugin", "enable", "demo"],
  ]);
  assert.deepEqual(builds, [false, true]);
  assert.equal(
    JSON.parse(
      await readFile(join(data, "custom/plugins/demo/plugin.json"), "utf8"),
    ).version,
    "1.0.0",
  );

  failBuild = true;
  id = await prepare("disable");
  await life.page(`life:confirm:${id}`);
  assert.equal((await readJob(life.dir, id)).phase, "uncertain");
  const beforeRetry = effects.length;
  await runJob(
    data,
    panels,
    id,
    runner,
    async () => true,
    async () => true,
    async () => true,
    async () => true,
  );
  assert.equal(
    effects.length,
    beforeRetry,
    "unknown build must never replay the command",
  );
  const blocked = await life.page(`life:prepare:${pluginKey("demo")}:enable`);
  assert.match(blocked.body, /Предыдущая задача/);
  assert(
    !blocked.rows
      .flat()
      .some((button) => button.id.startsWith("life:confirm:")),
  );
  console.log(
    "Native manager lifecycle passed: cancel/disable/duplicate/enable, failed build stays uncertain without replay; isolated build/systemd/health",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
