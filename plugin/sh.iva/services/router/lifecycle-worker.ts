import { realpath, stat, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn, execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema } from "./contracts.ts";
import { smallJson, type PluginEntry } from "./catalog.ts";
import {
  readJob,
  saveJob,
  registered,
  fingerprint,
  registryFingerprint,
} from "./lifecycle.ts";
import { supportedManager, stockArtifacts } from "./native-manager.ts";
import { fileURLToPath } from "node:url";
export const managedRun: Runner = (cli, args, data) =>
  nativeRun(
    fileURLToPath(new URL("./native-manager.mjs", import.meta.url)),
    [cli, ...args],
    data,
  );
export type Runner = (
  cli: string,
  args: string[],
  data: string,
) => Promise<number>;
export const nativeRun: Runner = (cli, args, data) =>
  new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ASSISTANT_DATA_DIR: data,
      IVA_DATA_DIR: data,
    };
    for (const key of [
      "HOME",
      "USER",
      "LOGNAME",
      "XDG_RUNTIME_DIR",
      "DBUS_SESSION_BUS_ADDRESS",
      "LANG",
    ])
      if (process.env[key]) env[key] = process.env[key];
    env.PATH = [
      dirname(process.execPath),
      ...(env.HOME ? [join(env.HOME, ".local/bin")] : []),
      "/usr/bin",
      "/bin",
    ].join(":");
    const child = spawn(process.execPath, [cli, ...args], {
      env,
      stdio: "ignore",
      timeout: 600_000,
      killSignal: "SIGTERM",
    });
    child.once("error", () => resolve(-1));
    child.once("exit", (code) => resolve(code ?? -1));
  });
export function lifecycleUnits(entry: PluginEntry): string[] {
  const names: string[] = [];
  for (const [field, prefix] of [
    ["mcp", "iva-mcp"],
    ["services", "iva-plugin"],
  ]) {
    const map = entry[field];
    if (map === undefined) continue;
    if (!map || typeof map !== "object" || Array.isArray(map))
      throw new Error("INVALID_UNITS");
    const keys = Object.keys(map);
    if (keys.length > 32) throw new Error("INVALID_UNITS");
    for (const key of keys) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(key))
        throw new Error("INVALID_UNITS");
      names.push(`${prefix}-${entry.name}-${key}.service`);
    }
  }
  return names;
}
export async function unitsHealthy(
  entry: PluginEntry,
  target: boolean,
): Promise<boolean> {
  const names = lifecycleUnits(entry);
  for (const name of names) {
    let state = "";
    for (let i = 0; i < 5; i++) {
      try {
        state = await new Promise<string>((resolve, reject) => {
          execFile(
            "systemctl",
            ["--user", "show", name, "--property=ActiveState", "--value"],
            { timeout: 3000, maxBuffer: 1024 },
            (error, stdout) =>
              error
                ? reject(new Error("UNIT_CHECK_FAILED"))
                : resolve(stdout.trim()),
          );
        });
      } catch {
        return false;
      }
      if (state !== "activating" && state !== "deactivating") break;
      await delay(1000);
    }
    if (state !== (target ? "active" : "inactive")) return false;
  }
  return true;
}
export async function ancillaryHealthy(
  data: string,
  cli?: string,
): Promise<boolean> {
  const query = (action: string) =>
    new Promise<string>((resolve) =>
      execFile(
        "systemctl",
        ["--user", action, "iva-telegram-userbot.service"],
        { timeout: 3000, maxBuffer: 1024 },
        (_error, stdout) => resolve(stdout.trim()),
      ),
    );
  if ((await query("is-enabled")) !== "enabled") return true;
  if ((await query("is-active")) !== "active") return false;
  try {
    let port = "8724";
    if (cli) {
      const { root } = await supportedManager(cli, data);
      const { createCliRuntime } = await import(
        pathToFileURL(join(root, "scripts/cli/runtime.ts")).href
      );
      const value = String(
        createCliRuntime(root).readEnv().TELEGRAM_MCP_PORT || port,
      );
      if (
        !/^\d{1,5}$/.test(value) ||
        Number(value) < 1 ||
        Number(value) > 65535
      )
        return false;
      port = value;
    }
    const token = (
      await readFile(join(data, "telegram-userbot.token"), "utf8")
    ).trim();
    const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    return r.ok && (await r.json()).state === "ready";
  } catch {
    return false;
  }
}
export async function runJob(
  data: string,
  panels: string,
  id: string,
  runner: Runner = managedRun,
  health?: () => Promise<boolean>,
  units: typeof unitsHealthy = unitsHealthy,
  artifacts: typeof stockArtifacts = stockArtifacts,
  ancillary: typeof ancillaryHealthy = ancillaryHealthy,
) {
  const dir = join(panels, "lifecycle");
  let job = await readJob(dir, id);
  if (job.phase !== "queued") return;
  try {
    const path = join(panels, "config.json"),
      info = await stat(path);
    if (info.mode & 0o077) throw new Error("PRIVATE_CONFIG_REQUIRED");
    const config = configSchema.parse(await smallJson(path, 16384));
    const original = await registered(data);
    const entry = original.find((e) => e.name === job.name);
    if (
      !config.lifecycle ||
      config.lifecycle.cli !== job.cli ||
      !entry ||
      !entry.trusted ||
      !job.registryFingerprint ||
      registryFingerprint(original) !== job.registryFingerprint ||
      job.name === "iva-panels" ||
      Date.now() > job.expires ||
      fingerprint(entry) !== job.fingerprint
    )
      throw new Error("STALE_JOB");
    if (runner === managedRun) await supportedManager(job.cli, data);
    if (!(await artifacts(job.cli, data))) throw new Error("INVALID_ARTIFACTS");
    for (const peer of original.filter((e) => e.name !== job.name)) {
      if (!(await units(peer, peer.enabled && peer.trusted)))
        throw new Error("UNHEALTHY_PEER");
    }
    if (!(await ancillary(data, job.cli))) throw new Error("UNHEALTHY_USERBOT");
    const before = await realpath(job.cli);
    if (!(await stat(before)).isFile()) throw new Error("MANAGER_UNAVAILABLE");
    lifecycleUnits(entry);
    let rebuild = false;
    for (const path of ["mcp.json", "sh.iva/extension"]) {
      try {
        await stat(join(data, "custom/plugins", job.name, path));
        rebuild = true;
      } catch {}
    }
    job.phase = "running";
    job.started = Date.now();
    await saveJob(dir, job);
    const exit = await runner(
      before,
      ["plugin", job.target ? "enable" : "disable", job.name],
      data,
    );
    const allAfter = await registered(data);
    const after = allAfter.find((e) => e.name === job.name);
    const unchanged =
      registryFingerprint(
        allAfter.map((e) =>
          e.name === job.name ? { ...e, enabled: entry.enabled } : e,
        ),
      ) === registryFingerprint(original);
    if (!unchanged) {
      job.issue = "registry_changed";
      const peers = new Map(original.map((e) => [e.name, fingerprint(e)]));
      job.affected = [
        ...new Set([
          ...original.map((e) => e.name),
          ...allAfter.map((e) => e.name),
        ]),
      ]
        .filter((name) => {
          const entryAfter = allAfter.find((e) => e.name === name);
          return (
            !entryAfter ||
            fingerprint(
              name === job.name
                ? { ...entryAfter, enabled: entry.enabled }
                : entryAfter,
            ) !== peers.get(name)
          );
        })
        .slice(0, 10);
    }
    let alive = false;
    if (health) alive = await health();
    else
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch(new URL("/eve/v1/health", config.upstream), {
            signal: AbortSignal.timeout(2000),
          });
          if (r.ok) {
            alive = true;
            break;
          }
        } catch {}
        await delay(1500);
      }
    const services = after ? await units(after, job.target) : false;
    let peersHealthy = true;
    for (const peer of allAfter.filter((e) => e.name !== job.name))
      if (!(await units(peer, peer.enabled && peer.trusted)))
        peersHealthy = false;
    const artifactsHealthy = await artifacts(job.cli, data);
    if (!job.issue && (!services || !peersHealthy))
      job.issue = "services_failed";
    if (!job.issue && !artifactsHealthy) job.issue = "artifacts_missing";
    if (!job.issue && exit !== 0) job.issue = "manager_failed";
    let ancillaryReady = false;
    for (let i = 0; i < 20; i++) {
      if (await ancillary(data, job.cli)) {
        ancillaryReady = true;
        break;
      }
      await delay(500);
    }
    if (!ancillaryReady) {
      peersHealthy = false;
      job.issue ??= "services_failed";
    }
    const rebuilt = !rebuild || (await realpath(job.cli)) !== before;
    job.phase =
      exit === 0 &&
      after?.enabled === job.target &&
      after?.trusted === true &&
      after?.sha === entry.sha &&
      after?.digest === entry.digest &&
      after?.source === entry.source &&
      unchanged &&
      peersHealthy &&
      artifactsHealthy &&
      services &&
      alive &&
      rebuilt
        ? "done"
        : "uncertain";
    job.completed = Date.now();
    await saveJob(dir, job);
  } catch (error) {
    if (job.phase !== "running")
      job.issue =
        error instanceof Error && error.message === "UNSUPPORTED_MANAGER"
          ? "unsupported_manager"
          : "preflight_failed";
    job.phase = job.phase === "running" ? "uncertain" : "failed";
    job.completed = Date.now();
    await saveJob(dir, job);
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [data, panels, id] = process.argv.slice(2);
  if (!data || !panels || !id) process.exitCode = 1;
  else
    await runJob(data, panels, id).catch(() => {
      process.exitCode = 1;
    });
}
