import { z } from "zod";
import { execFile } from "node:child_process";
import { promisify, parseEnv } from "node:util";
import {
  readFile,
  realpath,
  lstat,
  stat,
  readdir,
  chmod,
  mkdir,
} from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { supportedManager } from "./native-manager.ts";
import { smallJson, entrySchema } from "./catalog.ts";
import { configSchema } from "./contracts.ts";
import { digest, durableWrite, type SetupIO, type SetupPlan } from "./setup.ts";
const registrySchema = z.object({ plugins: z.array(entrySchema).max(1000) });
const routerService = z.object({
  router: z.object({ port: z.number().int().min(1).max(65535) }),
});
async function registryAt(data: string) {
  return registrySchema.parse(
    await smallJson(join(data, "custom/plugins.json"), 5 * 1024 * 1024),
  );
}
const exec = promisify(execFile);
const POLL = "iva-telegram-poll.service";
export async function command(binary: string, args: string[], timeout = 12000) {
  try {
    return (
      await exec(binary, args, {
        timeout,
        maxBuffer: 256 * 1024,
        env: process.env,
      })
    ).stdout.trim();
  } catch (error) {
    try {
      const report = JSON.parse(String((error as { stdout?: string }).stdout));
      if (/^SETUP_[A-Z_]+$/.test(report.error)) throw new Error(report.error);
    } catch (parsed) {
      if (parsed instanceof Error && /^SETUP_[A-Z_]+$/.test(parsed.message))
        throw parsed;
    }
    throw new Error("SETUP_SYSTEM_COMMAND_FAILED");
  } // Never log captured environment/output.
}
const ctl = (...args: string[]) => command("systemctl", ["--user", ...args]);
const show = (property: string) =>
  ctl("show", POLL, `--property=${property}`, "--value");
export async function discoverSetup() {
  if (process.platform !== "linux") throw new Error("SETUP_REQUIRES_LINUX");
  const current = await show("WorkingDirectory");
  if (!current.startsWith("/") || basename(current) !== "current")
    throw new Error("SETUP_UNSUPPORTED_LAYOUT");
  const envPath = join(current, ".env");
  const info = await stat(envPath);
  if (!info.isFile() || info.mode & 0o077 || info.size > 65536)
    throw new Error("SETUP_ENV_UNSAFE");
  const raw = await readFile(envPath, "utf8"),
    env = parseEnv(raw);
  const data = await realpath(
    resolve(current, env.ASSISTANT_DATA_DIR || "data"),
  );
  return { current, data, raw, env };
}
async function stockDropins() {
  const directory = join(homedir(), ".config/systemd/user", `${POLL}.d`);
  let parent = directory;
  while (!(await lstat(parent).catch(() => undefined)))
    parent = resolve(parent, "..");
  if ((await realpath(parent)) !== resolve(parent))
    throw new Error("SETUP_DIRECTORY_UNSAFE");
  if (
    (await show("DropInPaths")) ||
    (await readdir(directory).catch(() => [] as string[])).some((n) =>
      n.endsWith(".conf"),
    )
  )
    throw new Error("SETUP_EXISTING_ROUTE_OVERRIDE");
}
const pollPins: Record<string, string> = {
  "scripts/poller/config.ts":
    "ed3ca16acc2ebcd7a9bb08a33c16407879b8f1b8f7c3d92c368b356609e8efe8",
  "scripts/telegram-poll.mjs":
    "30e3bbf0c5c7577430e1a10150c9e330416c53346f3d321e19564aa0e1414145",
};
const quote = (s: string) => {
  if (/[\r\n\0%$]/.test(s)) throw new Error("SETUP_PATH_UNSAFE");
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
};
export function bridgeDropin(data: string, port: number) {
  return `[Service]\nExecStart=\nExecStart=/usr/bin/env ${quote(`ASSISTANT_HOST=http://127.0.0.1:${port}`)} ${quote(`ASSISTANT_DATA_DIR=${data}`)} node --env-file=.env scripts/telegram-poll.mjs\n`;
}
export function systemSetupIO(data: string, plugin: string): SetupIO {
  const directory = join(data, "plugin-data/iva-panels");
  const dropdir = join(homedir(), ".config/systemd/user", `${POLL}.d`);
  const routeFile = join(dropdir, "90-iva-panels-installer.conf");
  const unit = (id: string) => `iva-panels-setup-rollback-${id}`;
  async function plan(): Promise<SetupPlan> {
    const discovered = await discoverSetup();
    if (discovered.data !== (await realpath(data)))
      throw new Error("SETUP_DATA_MISMATCH");
    const cli = join(discovered.current, "bin/iva.mjs");
    const { root } = await supportedManager(cli, data);
    if (!basename(root).startsWith("0.5.7-ae313753a1ae"))
      throw new Error("SETUP_UNSUPPORTED_CORE");
    for (const [file, hash] of Object.entries(pollPins))
      if (digest(await readFile(join(root, file))) !== hash)
        throw new Error("SETUP_UNSUPPORTED_POLLER");
    await stockDropins();
    const poll = await ctl("cat", POLL);
    if (
      /ASSISTANT_HOST\s*=/.test(poll) ||
      !poll.includes("scripts/telegram-poll.mjs") ||
      !poll.includes("--env-file=.env") ||
      !(await show("ExecStart")).includes("scripts/telegram-poll.mjs")
    )
      throw new Error("SETUP_UNSUPPORTED_POLLER_UNIT");
    if ((await ctl("is-active", POLL)) !== "active")
      throw new Error("SETUP_BRIDGE_INACTIVE");
    const registry = await registryAt(data);
    const entries = registry.plugins.filter(
      (p: { name: string }) => p.name === "iva-panels",
    );
    if (entries.length !== 1 || !entries[0].enabled || !entries[0].trusted)
      throw new Error("SETUP_AWAITING_NATIVE_APPROVAL");
    if (
      (await realpath(plugin)) !==
      (await realpath(join(data, "custom/plugins/iva-panels")))
    )
      throw new Error("SETUP_NOT_INSTALLED_COPY");
    const port = routerService.parse(entries[0].services).router.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("SETUP_PORT_UNAVAILABLE");
    const ids = (discovered.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
      .split(/[,\s]+/)
      .filter(Boolean);
    if (
      ids.length !== 1 ||
      !/^[1-9]\d{0,15}$/.test(ids[0]) ||
      !Number.isSafeInteger(Number(ids[0]))
    )
      throw new Error("SETUP_REQUIRES_ONE_OWNER");
    const upstream = (
      discovered.env.ASSISTANT_HOST ||
      `http://127.0.0.1:${discovered.env.IVA_PORT || "8723"}`
    ).replace(/\/$/, "");
    const config = configSchema.parse({
      upstream,
      secret: discovered.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
      botToken: discovered.env.TELEGRAM_BOT_TOKEN,
      owners: [Number(ids[0])],
      mode: "panels",
      presentation: "classic",
      dynamicPanels: true,
    });
    if (
      Number(new URL(upstream).port || 80) === port ||
      !(await health(`${upstream}/eve/v1/health`))
    )
      throw new Error("SETUP_UPSTREAM_UNAVAILABLE");
    return {
      config,
      route: bridgeDropin(data, port),
      fingerprint: digest(
        JSON.stringify([
          root,
          digest(discovered.raw),
          digest(poll),
          entries[0],
        ]),
      ),
    };
  }
  return {
    directory,
    routeFile,
    plan,
    async arm(id) {
      // Copy the recovery bundle into persistent data; uninstalling/updating source cannot remove it.
      const recovery = join(directory, "installer-recovery.mjs");
      await durableWrite(
        recovery,
        await readFile(
          join(plugin, "sh.iva/services/router/install.mjs"),
          "utf8",
        ),
      );
      await command("systemd-run", [
        "--user",
        `--unit=${unit(id)}`,
        "--on-active=120s",
        "--timer-property=AccuracySec=1s",
        "--property=TimeoutStartSec=45s",
        "--property=RuntimeMaxSec=90s",
        "--collect",
        "/usr/bin/flock",
        "--wait=30",
        join(directory, "setup.lock"),
        process.execPath,
        recovery,
        "internal-rollback",
        data,
      ]);
    },
    async disarm(id) {
      await ctl("stop", `${unit(id)}.timer`);
    },
    async reload() {
      await ctl("daemon-reload");
    },
    async restartBridge() {
      await ctl("restart", POLL);
    },
    async healthy() {
      const c = configSchema.parse(
        JSON.parse(await readFile(join(directory, "config.json"), "utf8")),
      );
      const registry = await registryAt(data);
      const entry = registry.plugins.find((p) => p.name === "iva-panels");
      if (!entry) return false;
      const port = routerService.parse(entry.services).router.port;
      return (
        (await ctl("is-active", POLL)) === "active" &&
        (await show("ExecStart")).includes(
          `ASSISTANT_HOST=http://127.0.0.1:${port}`,
        ) &&
        (await health(`${c.upstream}/eve/v1/health`)) &&
        (await health(`http://127.0.0.1:${port}/eve/v1/health`))
      );
    },
    async canRestore() {
      const loaded = await show("DropInPaths");
      if (loaded && loaded !== routeFile) return false;
      return (await readdir(dropdir).catch(() => [] as string[]))
        .filter((n) => n.endsWith(".conf"))
        .every((n) => n === basename(routeFile));
    },
  };
}
async function health(url: string) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(3000),
      redirect: "error",
    });
    await r.body?.cancel();
    return r.status === 200;
  } catch {
    return false;
  }
}
/** All mutating worker invocations, including recovery, use one independent flock. */
export async function setupWorker(plugin: string, data: string, op: string) {
  const directory = join(data, "plugin-data/iva-panels");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid && info.uid !== process.getuid()) ||
    (await realpath(directory)) !== resolve(directory)
  )
    throw new Error("SETUP_DIRECTORY_UNSAFE");
  // Native install creates PLUGIN_DATA with default directory permissions; make our own data private before writing secrets.
  await chmod(directory, 0o700);
  const result = await command(
    "/usr/bin/flock",
    [
      "--nonblock",
      "--no-fork",
      join(directory, "setup.lock"),
      process.execPath,
      join(plugin, "sh.iva/services/router/install.mjs"),
      op,
      data,
    ],
    90000,
  );
  return JSON.parse(result);
}

export async function preflightInstall(plugin: string) {
  const d = await discoverSetup();
  const { root } = await supportedManager(
    join(d.current, "bin/iva.mjs"),
    d.data,
  );
  if (!basename(root).startsWith("0.5.7-ae313753a1ae"))
    throw new Error("SETUP_UNSUPPORTED_CORE");
  for (const [file, hash] of Object.entries(pollPins))
    if (digest(await readFile(join(root, file))) !== hash)
      throw new Error("SETUP_UNSUPPORTED_POLLER");
  const registry = await registryAt(d.data).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return { plugins: [] };
      throw error;
    },
  );
  if (registry.plugins.some((p: { name: string }) => p.name === "iva-panels"))
    return { state: "already_installed", data: d.data, current: d.current };
  await stockDropins();
  const poll = await ctl("cat", POLL);
  if (
    /ASSISTANT_HOST\s*=/.test(poll) ||
    !poll.includes("scripts/telegram-poll.mjs") ||
    !poll.includes("--env-file=.env") ||
    (await ctl("is-active", POLL)) !== "active"
  )
    throw new Error("SETUP_UNSUPPORTED_POLLER_UNIT");
  const ids = (d.env.TELEGRAM_ALLOWED_USER_IDS ?? "")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (
    ids.length !== 1 ||
    !/^[1-9]\d{0,15}$/.test(ids[0]) ||
    !Number.isSafeInteger(Number(ids[0]))
  )
    throw new Error("SETUP_REQUIRES_ONE_OWNER");
  const c = configSchema.parse({
    upstream: (
      d.env.ASSISTANT_HOST || `http://127.0.0.1:${d.env.IVA_PORT || "8723"}`
    ).replace(/\/$/, ""),
    secret: d.env.TELEGRAM_WEBHOOK_SECRET_TOKEN,
    botToken: d.env.TELEGRAM_BOT_TOKEN,
    owners: [Number(ids[0])],
  });
  if (!(await health(`${c.upstream}/eve/v1/health`)))
    throw new Error("SETUP_UPSTREAM_UNAVAILABLE");
  const manifest = await smallJson(join(plugin, "plugin.json"), 8192);
  if (manifest.name !== "iva-panels" || manifest.version !== "0.4.0-rc.1")
    throw new Error("SETUP_PACKAGE_MISMATCH");
  return { state: "ready_to_propose", data: d.data, current: d.current };
}
