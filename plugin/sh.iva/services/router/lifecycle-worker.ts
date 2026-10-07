import { realpath, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { spawn, execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { configSchema } from "./contracts.ts";
import { smallJson, type PluginEntry } from "./catalog.ts";
import { readJob, saveJob, registered, fingerprint } from "./lifecycle.ts";
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
    env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
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
export async function runJob(
  data: string,
  panels: string,
  id: string,
  runner: Runner = nativeRun,
  health?: () => Promise<boolean>,
  units: typeof unitsHealthy = unitsHealthy,
) {
  const dir = join(panels, "lifecycle");
  let job = await readJob(dir, id);
  if (job.phase !== "queued") return;
  try {
    const path = join(panels, "config.json"),
      info = await stat(path);
    if (info.mode & 0o077) throw new Error("PRIVATE_CONFIG_REQUIRED");
    const config = configSchema.parse(await smallJson(path, 16384));
    const entry = (await registered(data)).find((e) => e.name === job.name);
    if (
      !config.lifecycle ||
      config.lifecycle.cli !== job.cli ||
      !entry ||
      !entry.trusted ||
      job.name === "iva-panels" ||
      Date.now() > job.expires ||
      fingerprint(entry) !== job.fingerprint
    )
      throw new Error("STALE_JOB");
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
    const after = (await registered(data)).find((e) => e.name === job.name);
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
    const rebuilt = !rebuild || (await realpath(job.cli)) !== before;
    job.phase =
      exit === 0 &&
      after?.enabled === job.target &&
      after?.trusted === true &&
      after?.sha === entry.sha &&
      after?.digest === entry.digest &&
      after?.source === entry.source &&
      services &&
      alive &&
      rebuilt
        ? "done"
        : "uncertain";
    await saveJob(dir, job);
  } catch {
    job.phase = job.phase === "running" ? "uncertain" : "failed";
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
