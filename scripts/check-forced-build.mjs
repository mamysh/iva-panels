// Regression against unchanged stock updater; all state/build/probe are synthetic.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  symlink,
  unlink,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  forceBuild,
  supportedManager,
} from "../plugin/sh.iva/services/router/native-manager.ts";
const core = resolve(process.argv[2] || "");
const version = JSON.parse(
  await readFile(join(core, "package.json"), "utf8"),
).version;
const current = version === "0.5.7";

const stock = await import(
  pathToFileURL(join(core, "scripts/lib/version-update.ts")).href
);
const { fixtureRunner } = await import(
  pathToFileURL(join(core, "scripts/fixtures/version-update-harness.ts")).href
);
const home = await realpath(
  await mkdtemp(join(tmpdir(), "panels-force-build-")),
);
try {
  const repo = join(home, "repo"),
    data = join(home, "data");
  await mkdir(join(repo, "agent"), { recursive: true });
  await mkdir(join(repo, "scripts/migrations"), { recursive: true });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-b", "main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  await writeFile(
    join(repo, "package.json"),
    JSON.stringify({ name: "synthetic", version: "0.3.14", type: "module" }),
  );
  await writeFile(join(repo, "agent/agent.ts"), "export const agent=1;\n");
  git("add", ".");
  git("commit", "-m", "synthetic fixture");
  const target = { sha: git("rev-parse", "HEAD"), version: "0.3.14" };
  for (const name of ["files", "peer"]) {
    const dir = join(data, "custom/plugins", name);
    await mkdir(join(dir, "skills/demo"), { recursive: true });
    await writeFile(
      join(dir, "skills/demo/SKILL.md"),
      "---\nname: demo\ndescription: Synthetic fixture\n---\nDemo.\n",
    );
    await writeFile(
      join(dir, "plugin.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name,
        version: "1.0.0",
        ...(name === "files" ? { extensions: { "sh.iva": {} } } : {}),
      }),
    );
    if (name === "files") {
      await mkdir(join(dir, "sh.iva/extension"), { recursive: true });
      await writeFile(
        join(dir, "sh.iva/extension/extension.ts"),
        "export default {name:'files'};\n",
      );
      await writeFile(
        join(dir, "sh.iva/package.json"),
        JSON.stringify({
          name,
          version: "1.0.0",
          eve: {
            extension: { source: "./extension", dist: "./dist/extension" },
          },
        }),
      );
      await writeFile(
        join(dir, "sh.iva/tsconfig.json"),
        JSON.stringify({ include: ["extension/**/*.ts"] }),
      );
    }
    await writeFile(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          api: { type: "streamable-http", url: "https://synthetic.test/mcp" },
        },
      }),
    );
  }
  const registry = join(data, "custom/plugins.json");
  const both = ["files", "peer"].map((name) => ({
    name,
    source: "synthetic",
    ref: "",
    sha: "",
    digest: "",
    enabled: true,
    trusted: true,
    installedAt: "2026-01-01T00:00:00.000Z",
  }));
  const put = (plugins) =>
    writeFile(
      registry,
      JSON.stringify({ version: 1, marketplaces: [], plugins }),
    );
  const options = {
    run: fixtureRunner(),
    probe: async () => ({ ok: true, log: "" }),
    serving: async () => ({ ok: true, log: "" }),
    startCandidate: async () => {},
    resumeOldWriters: async () => {},
  };
  const update = () =>
    stock.runVersionUpdate({
      home,
      resolveTarget: async () => target,
      ...options,
    });
  await put(both);
  const overlay = await stock.versionOverlay(data, console.log);
  assert.equal(
    overlay.plugins.length,
    2,
    "fixture plugins must participate in the version",
  );
  const first = await update();
  assert.equal(first.status, "updated");
  await put([both[0], { ...both[1], enabled: false }]);
  assert.equal((await update()).status, "updated");
  await put(both);
  const reused = await update();
  assert.equal(reused.status, "updated");
  assert.equal(reused.version, first.version);
  const dropped = JSON.parse(await readFile(registry, "utf8")).plugins;
  assert(
    dropped.some((plugin) => !plugin.enabled),
    "unchanged stock reuse still drops an MCP-only peer: the force-build workaround must remain",
  );
  // Real native toggle dispatcher wired to the Panels force callback.
  await put(both);
  let builds = 0;
  const forced = {
    ...options,
    run: fixtureRunner(async (step) => {
      if (step === "build") builds++;
    }),
    handoff: undefined,
  };
  const { createCliRuntime } = await import(
    pathToFileURL(join(core, "scripts/cli/runtime.ts")).href
  );
  const { createPluginCommands } = await import(
    pathToFileURL(join(core, "scripts/cli/plugin.ts")).href
  );
  const runtime = {
    ...createCliRuntime(core),
    dataDirAbs: () => data,
    readEnv: () => ({ IVA_DATA_DIR: data }),
    hasSystemd: () => false,
    ok: () => {},
    warn: () => {},
    bad: () => {},
    step: () => {},
  };
  const { cmdPlugin } = createPluginCommands(runtime, {
    translate: (en) => en,
    log: () => {},
    buildVersion: () => forceBuild(core, home, forced),
  });
  const buildApi = await import(
    pathToFileURL(join(core, "scripts/lib/plugin-build.ts")).href
  );
  const { createVersionStore } = await import(
    pathToFileURL(join(core, "scripts/lib/version-store.ts")).href
  );
  async function assertComposition(enabled) {
    const actual = JSON.parse(await readFile(registry, "utf8")).plugins;
    assert.deepEqual(
      actual,
      both.map((entry, index) => ({ ...entry, enabled: enabled[index] })),
      "target toggle must preserve all peer metadata",
    );
    const plugins = await buildApi.codePlugins(data);
    assert.deepEqual(plugins.diagnostics, []);
    assert.deepEqual(
      plugins.plugins.map((plugin) => plugin.name).sort(),
      both
        .filter((_entry, index) => enabled[index])
        .map((entry) => entry.name)
        .sort(),
    );
    const running = createVersionStore(home).currentName();
    assert(running);
    assert.deepEqual(
      buildApi.pluginsMissingArtifacts(
        join(home, "versions", running),
        plugins.plugins,
      ),
      [],
      "all enabled peers must keep their built artifacts",
    );
  }
  await cmdPlugin(["disable", "files"]);
  assert.deepEqual(
    JSON.parse(await readFile(registry, "utf8")).plugins.map((p) => p.enabled),
    [false, true],
  );
  await assertComposition([false, true]);
  await cmdPlugin(["enable", "files"]);
  await assertComposition([true, true]);
  assert(builds >= 2, "each changed composition must get a fresh build");
  assert.deepEqual(
    JSON.parse(await readFile(registry, "utf8")).plugins.map((p) => p.enabled),
    [true, true],
  );
  if (["0.4.12", "0.4.14", "0.5.7"].includes(version)) {
    const pin = current
      ? "0.5.7-ae313753a1ae"
      : version === "0.4.14"
        ? "0.4.14-fa5586557f41"
        : "0.4.12-5cf8f1963c82";
    const sources = current
      ? [
          "scripts/cli/plugin.ts",
          "scripts/cli/plugin-cli-context.ts",
          "scripts/cli/plugin-cli-trust.ts",
          "scripts/cli/runtime.ts",
          "scripts/lib/plugin-core.ts",
          "scripts/lib/version-update.ts",
          "scripts/lib/version-store.ts",
          "scripts/lib/plugin-build.ts",
          "scripts/lib/plugin-units.ts",
          "scripts/update-finish.ts",
        ]
      : ["scripts/lib/version-update.ts", "scripts/cli/plugin.ts"];
    const root = join(home, `versions/${pin}+deadbeef~2`);
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin/iva.mjs"), "// synthetic entry\n");
    for (const file of sources) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), await readFile(join(core, file)));
    }
    await unlink(join(home, "current"));
    await symlink(root, join(home, "current"));
    assert.equal(
      (await supportedManager(join(root, "bin/iva.mjs"), data)).home,
      await realpath(home),
    );
    const manager = await supportedManager(join(root, "bin/iva.mjs"), data);
    // Each pin must match the independently checked-out upstream file, and a
    // changed delegated module must be refused before a command is available.
    for (const file of sources) {
      const original = await readFile(join(root, file));
      await unlink(join(root, file));
      await assert.rejects(
        supportedManager(join(root, "bin/iva.mjs"), data),
        /UNSUPPORTED_MANAGER/,
      );
      await writeFile(join(root, file), "// incompatible source\n");
      await assert.rejects(
        supportedManager(join(root, "bin/iva.mjs"), data),
        /UNSUPPORTED_MANAGER/,
      );
      await writeFile(join(root, file), original);
    }

    const serviceRuntime = createCliRuntime(manager.runtimeRoot);
    const { pluginUnitPlan, reconcilePluginUnits } = await import(
      pathToFileURL(join(core, "scripts/lib/plugin-units.ts")).href
    );
    await mkdir(join(root, "services/mcp-proxy"), { recursive: true });
    await writeFile(
      join(root, "services/mcp-proxy/serve.ts"),
      "// old proxy\n",
    );
    const unitDir = join(home, "synthetic-units");
    const plan = pluginUnitPlan({
      plugins: [
        {
          name: "peer",
          enabled: true,
          trusted: true,
          root: join(data, "custom/plugins/peer"),
          data: join(data, "plugin-data/peer"),
          mcp: [
            { server: "api", port: 8730, tokenFile: join(data, "peer.token") },
          ],
          services: [],
        },
      ],
      root: serviceRuntime.ROOT,
      node: serviceRuntime.NODE,
      nodeBinDir: serviceRuntime.NODE_BIN_DIR,
      dataDir: data,
      dataDirEnvironment: '"ASSISTANT_DATA_DIR=' + data + '"',
    });
    const checkStart = async () => {
      const body = await readFile(join(unitDir, plan.units[0].unit), "utf8");
      const cwd = body.match(/^WorkingDirectory=(.+)$/m)[1];
      const entrypoint = body.match(
        /"([^"\n]+\/services\/mcp-proxy\/serve.ts)"/,
      )[1];
      assert.equal(cwd, join(home, "current"));
      assert.equal(
        entrypoint,
        join(home, "current/services/mcp-proxy/serve.ts"),
      );
      await realpath(cwd);
      return readFile(entrypoint, "utf8");
    };
    const reconciled = reconcilePluginUnits({
      plan,
      unitDir,
      systemd: {
        activate: () => {},
        restart: () => {},
        disableNow: () => {},
        daemonReload: () => {},
        resetFailed: () => {},
      },
    });
    assert.deepEqual(reconciled.failures, []);
    assert.match(await checkStart(), /old proxy/);
    // The generated unit is NOT rewritten after a flip or old-version pruning.
    const next = join(home, `versions/${pin}+cafebabe~3`);
    await mkdir(join(next, "services/mcp-proxy"), { recursive: true });
    await writeFile(
      join(next, "services/mcp-proxy/serve.ts"),
      "// next proxy\n",
    );
    await unlink(join(home, "current"));
    await symlink(next, join(home, "current"));
    await assert.rejects(
      supportedManager(join(root, "bin/iva.mjs"), data),
      /UNSUPPORTED_LAYOUT/,
    );
    await rm(root, { recursive: true });
    assert.match(await checkStart(), /next proxy/);
    // Restore every pinned source after pruning; then tamper only the updater.
    await mkdir(join(root, "bin"), { recursive: true });
    await writeFile(join(root, "bin/iva.mjs"), "// synthetic entry\n");
    for (const file of sources) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), await readFile(join(core, file)));
    }
    await unlink(join(home, "current"));
    await symlink(root, join(home, "current"));
    await writeFile(
      join(root, "scripts/lib/version-update.ts"),
      "// changed manager\n",
    );
    await assert.rejects(
      supportedManager(join(root, "bin/iva.mjs"), data),
      /UNSUPPORTED_MANAGER/,
    );
  }
  console.log(
    `Unchanged stock ${version}: reuse reproduced MCP-only auto-drop; forced disable/enable preserved both plugins; exact source pins and MCP paths survived checks`,
  );
} finally {
  await rm(home, { recursive: true, force: true });
}
