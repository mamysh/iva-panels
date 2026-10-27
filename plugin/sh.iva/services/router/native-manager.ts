import { createHash } from "node:crypto";
import { readFile, realpath, mkdtemp, rm } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { pluginName } from "./catalog.ts";
type Manager = { version: string; sources: Record<string, string> };
const legacyPlugin =
  "1999e073129e13f71fa1bed476f946fe34fd4f29d12afa8db66459599c834b3a";
const managers: Manager[] = [
  {
    version: "0.4.12-5cf8f1963c82",
    sources: {
      "scripts/lib/version-update.ts":
        "65abf07fd303080e5a41b28149d8fb67fde0a1b67cea2064c35f93f4a2261090",
      "scripts/cli/plugin.ts": legacyPlugin,
    },
  },
  {
    version: "0.4.14-fa5586557f41",
    sources: {
      "scripts/lib/version-update.ts":
        "10d6e8cb6ea8f2de30bdc075dbb51e6ad0bacede1a9ffd03b49ee896c778418e",
      "scripts/cli/plugin.ts": legacyPlugin,
    },
  },
  {
    version: "0.5.7-ae313753a1ae",
    sources: {
      "scripts/cli/plugin.ts":
        "1999e073129e13f71fa1bed476f946fe34fd4f29d12afa8db66459599c834b3a",
      "scripts/cli/plugin-cli-context.ts":
        "6ecf9ff56e3a7fd261d3925a92946330a344afe659ef7c804c4db80fe1f5c851",
      "scripts/cli/plugin-cli-trust.ts":
        "920588e3ca3b1bd409d4608437dcd4fdbb7ab404675dd8f9254fc1908f46aff8",
      "scripts/cli/runtime.ts":
        "636dcebc236c7a61a806c9ab6c928a2eb3d61882f764867fc9c49e02898f6bdc",
      "scripts/lib/plugin-core.ts":
        "b30f5558d2845d083cd86a4ec065a1bca66e3882a3ade4ae1786e73fb19568d8",
      "scripts/lib/version-update.ts":
        "48e3ad0d7c4fdb4a1d79690725f9d3cb234f1b0fa8faac1d8b9b5e7d34aab312",
      "scripts/lib/version-store.ts":
        "095b51562a2bca2a32d932e2b637fd07487ea393c5758b35d07b55dfbd512d20",
      "scripts/lib/plugin-build.ts":
        "b0002b6387f76a57c83ba12885b2e848a9450a9ac09323ff196382e5e48a43d7",
      "scripts/lib/plugin-units.ts":
        "65107f12097944d02f7629a2cafffdbb9c8a58b537066dcb505b8ca2391785b9",
      "scripts/update-finish.ts":
        "297c73a1ac041771339aedac12ae1ebc5f447c2b48f1dc283ab832385301d865",
    },
  },
];
function managerFor(name: string) {
  return managers.find(
    (m) =>
      name === m.version ||
      new RegExp(
        `^${m.version.replaceAll(".", "\\.")}(?:\\+[a-f0-9]{8})?(?:~[1-9][0-9]*)?$`,
      ).test(name),
  );
}
export function supportedVersion(name: string) {
  return managerFor(name) !== undefined;
}
export async function supportedManager(cli: string, data: string) {
  const root = dirname(dirname(await realpath(cli)));
  const manager = managerFor(basename(root));
  if (!manager) throw new Error("UNSUPPORTED_MANAGER");
  const home = dirname(dirname(root));
  if ((await realpath(data)) !== (await realpath(join(home, "data"))))
    throw new Error("UNSUPPORTED_LAYOUT");
  for (const [file, hash] of Object.entries(manager.sources)) {
    if (
      createHash("sha256")
        .update(await readFile(join(root, file)))
        .digest("hex") !== hash
    )
      throw new Error("UNSUPPORTED_MANAGER");
  }
  // Validate immutable code using its exact path, but keep generated services on
  // the installation symlink so later flips and version pruning cannot break them.
  const runtimeRoot = join(home, "current");
  if ((await realpath(runtimeRoot)) !== root)
    throw new Error("UNSUPPORTED_LAYOUT");
  return { root, home, runtimeRoot };
}
// The unchanged stock updater already supports force and a pinned target. Never
// resolve a newer release or alter the installation's update branch here.
export async function forceBuild(
  root: string,
  home: string,
  overrides: Record<string, unknown> = {},
) {
  const stock = await import(
    pathToFileURL(join(root, "scripts/lib/version-update.ts")).href
  );
  const storeModule = await import(
    pathToFileURL(join(root, "scripts/lib/version-store.ts")).href
  );
  const store = storeModule.createVersionStore(home);
  const target = storeModule.parseVersionName(store.currentName());
  if (!target) throw new Error("NO_CURRENT_VERSION");
  const sha = execFileSync("git", ["rev-parse", target.sha], {
    cwd: join(home, "repo"),
    encoding: "utf8",
  }).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("INVALID_VERSION");
  const reportDir = await mkdtemp(join(tmpdir(), "iva-panels-build-"));
  const report = join(reportDir, "outcome.json");
  try {
    const outcome = await stock.runVersionUpdate({
      home,
      store,
      run: stock.commandRunner(false),
      handoff: async (name: string) => {
        const dir = join(home, "versions", name);
        const result = spawnSync(
          process.execPath,
          [
            join(dir, "scripts/update-finish.ts"),
            home,
            name,
            "--require-plugins",
          ],
          {
            cwd: dir,
            stdio: "ignore",
            env: { ...process.env, IVA_UPDATE_OUTCOME: report },
            timeout: 590_000,
          },
        );
        if (result.error || result.status !== 0)
          throw new Error("BUILD_FAILED");
        return JSON.parse(await readFile(report, "utf8"));
      },
      ...overrides,
      force: true,
      requirePlugins: true,
      resolveTarget: async () => ({ sha, version: target.version }),
    });
    return outcome.status === "updated" || outcome.status === "current"
      ? { status: "built", version: outcome.version }
      : { status: "failed", reason: "Native build did not complete" };
  } finally {
    await rm(reportDir, { recursive: true, force: true });
  }
}
export async function stockArtifacts(
  cli: string,
  data: string,
): Promise<boolean> {
  const { root } = await supportedManager(cli, data);
  const stock = await import(
    pathToFileURL(join(root, "scripts/lib/plugin-build.ts")).href
  );
  const result = await stock.codePlugins(data);
  return (
    result.diagnostics.length === 0 &&
    stock.pluginsMissingArtifacts(root, result.plugins).length === 0
  );
}
export async function manage(
  cli: string,
  verb: string,
  name: string,
  data: string,
) {
  if (!["enable", "disable"].includes(verb) || name === "iva-panels")
    throw new Error("INVALID_COMMAND");
  pluginName.parse(name);
  const { root, home, runtimeRoot } = await supportedManager(cli, data);
  const { createCliRuntime } = await import(
    pathToFileURL(join(root, "scripts/cli/runtime.ts")).href
  );
  const { createPluginCommands } = await import(
    pathToFileURL(join(root, "scripts/cli/plugin.ts")).href
  );
  const runtime = createCliRuntime(runtimeRoot);
  const { cmdPlugin } = createPluginCommands(runtime, {
    buildVersion: () => forceBuild(root, home),
  });
  await cmdPlugin([verb, name]);
  if (process.exitCode) throw new Error("MANAGER_FAILED");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [cli, group, verb, name] = process.argv.slice(2);
  if (!cli || group !== "plugin" || !verb || !name || !process.env.IVA_DATA_DIR)
    process.exitCode = 1;
  else
    await manage(cli, verb, name, process.env.IVA_DATA_DIR).catch(() => {
      process.exitCode = 1;
    });
}
