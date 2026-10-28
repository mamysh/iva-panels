import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, rename, link, lstat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { configSchema, type Config } from "./contracts.ts";

export const digest = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const journalSchema = z
  .object({
    schema: z.literal(1),
    id: z.string().regex(/^[a-f0-9]{24}$/),
    phase: z.enum([
      "prepared",
      "routing",
      "connected",
      "rolled_back",
      "uncertain",
    ]),
    fingerprint: hash,
    configHash: hash,
    routeHash: hash,
    notice: z.enum(["none", "attempted", "presented", "delivery_unknown"]),
  })
  .strict();
export type SetupJournal = z.infer<typeof journalSchema>;
export type SetupPlan = { config: Config; route: string; fingerprint: string };
export interface SetupIO {
  directory: string;
  routeFile: string;
  plan(): Promise<SetupPlan>;
  arm(id: string): Promise<void>;
  disarm(id: string): Promise<void>;
  reload(): Promise<void>;
  restartBridge(): Promise<void>;
  healthy(): Promise<boolean>;
  canRestore(): Promise<boolean>;
}
export async function privateFile(path: string): Promise<string | undefined> {
  let f;
  try {
    f = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("SETUP_FILE_UNSAFE");
  }
  try {
    const info = await f.stat();
    if (
      !info.isFile() ||
      info.size > 65536 ||
      info.mode & 0o077 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("SETUP_FILE_UNSAFE");
    const buffer = Buffer.alloc(65537);
    const { bytesRead } = await f.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65536) throw new Error("SETUP_FILE_UNSAFE");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await f.close();
  }
}
export async function durableWrite(
  path: string,
  text: string,
  exclusive = false,
) {
  const temp = `${path}.${randomBytes(8).toString("hex")}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(text);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (exclusive) {
      await link(temp, path);
      await unlink(temp);
    } else await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
  const directory = await open(join(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function setupState(
  directory: string,
): Promise<SetupJournal | undefined> {
  const text = await privateFile(join(directory, "setup.json"));
  return text === undefined ? undefined : journalSchema.parse(JSON.parse(text));
}
const save = (io: SetupIO, state: SetupJournal, exclusive = false) =>
  durableWrite(
    join(io.directory, "setup.json"),
    JSON.stringify(journalSchema.parse(state)),
    exclusive,
  );

/** Callers serialize every write with the same Linux flock, including the timer. */
export async function prepareSetup(io: SetupIO): Promise<boolean> {
  await mkdir(io.directory, { recursive: true, mode: 0o700 });
  const info = await lstat(io.directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
    throw new Error("SETUP_DIRECTORY_UNSAFE");
  const previous = await setupState(io.directory);
  const config = await privateFile(join(io.directory, "config.json"));
  if (previous?.phase === "routing") {
    await rollbackSetup(io);
    return false;
  }
  if (previous && previous.phase !== "prepared") return false;
  if (!previous && config !== undefined) return false; // Existing installations remain untouched.
  const plan = await io.plan();
  const text = JSON.stringify(configSchema.parse(plan.config));
  if (
    previous &&
    (previous.fingerprint !== plan.fingerprint ||
      previous.configHash !== digest(text))
  )
    throw new Error("SETUP_CHANGED");
  if (!previous)
    await save(
      io,
      {
        schema: 1,
        id: randomBytes(12).toString("hex"),
        phase: "prepared",
        fingerprint: plan.fingerprint,
        configHash: digest(text),
        routeHash: digest(plan.route),
        notice: "none",
      },
      true,
    );
  if (config === undefined)
    await durableWrite(join(io.directory, "config.json"), text, true);
  else if (digest(config) !== digest(text))
    throw new Error("SETUP_CONFIG_CHANGED");
  return true;
}
export async function activateSetup(io: SetupIO): Promise<string | undefined> {
  const state = await setupState(io.directory);
  if (!state || state.phase !== "prepared") return undefined;
  const plan = await io.plan();
  const config = await privateFile(join(io.directory, "config.json"));
  if (
    plan.fingerprint !== state.fingerprint ||
    digest(plan.route) !== state.routeHash ||
    !config ||
    digest(config) !== state.configHash
  )
    throw new Error("SETUP_CHANGED");
  state.phase = "routing";
  await save(io, state); // Intent before timer, file, reload or restart.
  let armed = false;
  try {
    await io.arm(state.id);
    armed = true; // Independent recovery must exist before changing the route.
    await mkdir(join(io.routeFile, ".."), { recursive: true, mode: 0o700 });
    await durableWrite(io.routeFile, plan.route, true); // Never replace someone else's drop-in.
    await io.reload();
    await io.restartBridge();
    if (!(await io.healthy())) throw new Error("SETUP_HEALTH_FAILED");
    state.phase = "connected";
    state.notice = "attempted";
    await save(io, state);
    await io.disarm(state.id).catch(() => {}); // A late timer sees connected and is a no-op.
    return state.id;
  } catch {
    if (armed) await rollbackSetup(io);
    else {
      state.phase = "rolled_back";
      await save(io, state);
      await io.disarm(state.id).catch(() => {});
    }
    throw new Error("SETUP_ACTIVATION_FAILED");
  }
}
export async function rollbackSetup(
  io: SetupIO,
  explicit = false,
): Promise<void> {
  const state = await setupState(io.directory);
  if (
    !state ||
    state.phase === "rolled_back" ||
    (!explicit && state.phase !== "routing")
  )
    return;
  const route = await privateFile(io.routeFile).catch(() => null);
  if (
    route === null ||
    (route !== undefined && digest(route) !== state.routeHash) ||
    !(await io.canRestore())
  ) {
    state.phase = "uncertain";
    await save(io, state);
    throw new Error("SETUP_ROUTE_CHANGED");
  }
  try {
    if (route !== undefined) {
      await unlink(io.routeFile);
      const directory = await open(join(io.routeFile, ".."), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
    await io.reload();
    await io.restartBridge();
    state.phase = "rolled_back";
    await save(io, state);
    await io.disarm(state.id).catch(() => {});
  } catch {
    state.phase = "uncertain";
    await save(io, state);
    throw new Error("SETUP_ROLLBACK_UNCONFIRMED");
  }
}
export async function noticeSetup(
  io: SetupIO,
  outcome: "presented" | "delivery_unknown",
) {
  const state = await setupState(io.directory);
  if (state?.phase !== "connected" || state.notice !== "attempted") return;
  state.notice = outcome;
  await save(io, state);
}

export async function retrySetup(io: SetupIO) {
  const state = await setupState(io.directory);
  if (state?.phase !== "rolled_back")
    throw new Error("SETUP_RETRY_NOT_ALLOWED");
  const current = await privateFile(join(io.directory, "config.json"));
  if (!current || digest(current) !== state.configHash)
    throw new Error("SETUP_CONFIG_CHANGED");
  const plan = await io.plan(),
    text = JSON.stringify(configSchema.parse(plan.config));
  await durableWrite(join(io.directory, "config.json"), text);
  await save(io, {
    schema: 1,
    id: randomBytes(12).toString("hex"),
    phase: "prepared",
    fingerprint: plan.fingerprint,
    configHash: digest(text),
    routeHash: digest(plan.route),
    notice: "none",
  });
}
