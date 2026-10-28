import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
  readdir,
  symlink,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  prepareSetup,
  activateSetup,
  rollbackSetup,
  retrySetup,
  noticeSetup,
  setupState,
  digest,
  durableWrite,
  type SetupIO,
} from "../plugin/sh.iva/services/router/setup.ts";
import { configSchema } from "../plugin/sh.iva/services/router/contracts.ts";
import { proposePackage } from "../plugin/sh.iva/services/router/install.ts";
import { bridgeDropin } from "../plugin/sh.iva/services/router/setup-system.ts";
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "panels-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "data"),
    routeFile = join(root, "units/90-iva-panels-installer.conf");
  const config = configSchema.parse({
    upstream: "http://127.0.0.1:8723",
    secret: "synthetic-secret-123",
    botToken: "42:synthetic",
    owners: [42],
    mode: "panels",
    dynamicPanels: true,
  });
  const calls: string[] = [];
  let failure = "",
    approved = true,
    changed = false;
  function effect(name: string) {
    calls.push(name);
    if (failure === name) {
      failure = "";
      throw new Error("synthetic");
    }
  }
  const io: SetupIO = {
    directory,
    routeFile,
    async plan() {
      if (!approved) throw new Error("SETUP_AWAITING_NATIVE_APPROVAL");
      return {
        config,
        route: bridgeDropin(directory, 8735),
        fingerprint: digest(changed ? "changed" : "baseline"),
      };
    },
    async arm() {
      assert.equal((await setupState(directory))?.phase, "routing");
      await assert.rejects(stat(routeFile));
      effect("arm");
    },
    async disarm() {
      effect("disarm");
    },
    async reload() {
      effect("reload");
    },
    async restartBridge() {
      effect("restart");
    },
    async healthy() {
      effect("health");
      return true;
    },
    async canRestore() {
      return (await readdir(join(root, "units")).catch(() => [])).every(
        (n) => n === "90-iva-panels-installer.conf",
      );
    },
  };
  return {
    root,
    io,
    calls,
    fail: (name: string) => {
      failure = name;
    },
    approval: (v: boolean) => {
      approved = v;
    },
    change: () => {
      changed = true;
    },
  };
}
test("prepare has no route effect; durable timer precedes change; commit and late timer never replay", async (t) => {
  const f = await fixture(t);
  assert(await prepareSetup(f.io));
  assert.deepEqual(f.calls, []);
  await assert.rejects(stat(f.io.routeFile));
  const secret = await readFile(join(f.io.directory, "config.json"), "utf8");
  assert.equal(
    (await stat(join(f.io.directory, "config.json"))).mode & 0o777,
    0o600,
  );
  assert(
    !(await readFile(join(f.io.directory, "setup.json"), "utf8")).includes(
      "synthetic-secret",
    ),
  );
  const id = await activateSetup(f.io);
  assert.match(id!, /^[a-f0-9]{24}$/);
  assert.deepEqual(f.calls, ["arm", "reload", "restart", "health", "disarm"]);
  await rollbackSetup(f.io);
  await activateSetup(f.io);
  assert.equal(f.calls.length, 5);
  await noticeSetup(f.io, "delivery_unknown");
  await noticeSetup(f.io, "presented");
  assert.equal((await setupState(f.io.directory))?.notice, "delivery_unknown");
  await rollbackSetup(f.io, true);
  assert.equal((await setupState(f.io.directory))?.phase, "rolled_back");
  await assert.rejects(stat(f.io.routeFile));
  assert.equal(
    await readFile(join(f.io.directory, "config.json"), "utf8"),
    secret,
  );
});
test("timer/reload/restart/health failure restores original route; no timer means no route or bridge effect", async (t) => {
  for (const failure of ["arm", "reload", "restart", "health"]) {
    const f = await fixture(t);
    await prepareSetup(f.io);
    f.fail(failure);
    await assert.rejects(activateSetup(f.io));
    assert.equal((await setupState(f.io.directory))?.phase, "rolled_back");
    await assert.rejects(stat(f.io.routeFile));
    if (failure === "arm") assert.deepEqual(f.calls, ["arm", "disarm"]);
  }
});
test("interrupted routing recovers without replay; recovery failure or an operator edit becomes uncertain", async (t) => {
  const f = await fixture(t);
  await prepareSetup(f.io);
  const s = (await setupState(f.io.directory))!;
  s.phase = "routing";
  await durableWrite(join(f.io.directory, "setup.json"), JSON.stringify(s));
  await mkdir(join(f.io.routeFile, ".."), { recursive: true });
  await durableWrite(f.io.routeFile, (await f.io.plan()).route, true);
  assert.equal(await prepareSetup(f.io), false);
  assert.equal((await setupState(f.io.directory))?.phase, "rolled_back");
  assert(!f.calls.includes("arm"));
  await retrySetup(f.io);
  await activateSetup(f.io);
  await writeFile(f.io.routeFile, "operator-owned change", { mode: 0o600 });
  await assert.rejects(rollbackSetup(f.io, true));
  assert.equal((await setupState(f.io.directory))?.phase, "uncertain");
  assert.equal(await readFile(f.io.routeFile, "utf8"), "operator-owned change");
  await assert.rejects(retrySetup(f.io));
});
test("existing manual config, missing approval, changed plan/config and symlinks never route", async (t) => {
  const f = await fixture(t);
  await mkdir(f.io.directory, { mode: 0o700 });
  await writeFile(
    join(f.io.directory, "config.json"),
    "private manual config",
    { mode: 0o600 },
  );
  assert.equal(await prepareSetup(f.io), false);
  assert.deepEqual(f.calls, []);
  const g = await fixture(t);
  g.approval(false);
  await assert.rejects(prepareSetup(g.io));
  assert.deepEqual(g.calls, []);
  g.approval(true);
  await prepareSetup(g.io);
  g.change();
  await assert.rejects(activateSetup(g.io));
  assert.deepEqual(g.calls, []);
  const h = await fixture(t);
  await prepareSetup(h.io);
  await writeFile(join(h.io.directory, "config.json"), "operator change", {
    mode: 0o600,
  });
  await assert.rejects(activateSetup(h.io));
  assert.deepEqual(h.calls, []);
  await rm(join(h.io.directory, "setup.json"));
  await symlink(
    join(h.io.directory, "config.json"),
    join(h.io.directory, "setup.json"),
  );
  await assert.rejects(prepareSetup(h.io));
});
test("proposal uses stock propose only; unknown send and repeat cannot bypass the native tap", async (t) => {
  const f = await fixture(t);
  const pkg = join(f.root, "plugin");
  await mkdir(pkg);
  await writeFile(join(pkg, "plugin.json"), '{"name":"iva-panels"}');
  const calls: string[][] = [];
  const invoke = async (_bin: string, args: string[]) => {
    calls.push(args);
    return "";
  };
  assert.equal(
    (await proposePackage(f.root, join(f.root, "current"), pkg, invoke)).state,
    "proposal_sent",
  );
  assert.equal(
    (await proposePackage(f.root, join(f.root, "current"), pkg, invoke)).state,
    "proposal_already_sent",
  );
  assert.deepEqual(calls[0].slice(1), ["plugin", "propose", pkg]);
  assert.equal(calls.length, 1);
  const g = await fixture(t);
  let sends = 0;
  await assert.rejects(
    proposePackage(g.root, join(g.root, "current"), pkg, async () => {
      sends++;
      throw new Error("lost response");
    }),
  );
  assert.equal(
    (await proposePackage(g.root, join(g.root, "current"), pkg, invoke)).state,
    "proposal_delivery_unknown",
  );
  assert.equal(sends, 1);
  assert.equal(calls.length, 1);
});
test("drop-in uses current-relative stock entrypoint and rejects systemd expansion characters", () => {
  const text = bridgeDropin("/tmp/space here/data", 8735);
  assert(text.includes('"ASSISTANT_DATA_DIR=/tmp/space here/data"'));
  assert(text.includes("node --env-file=.env scripts/telegram-poll.mjs"));
  assert(!text.includes("versions/"));
  for (const path of ["/tmp/$HOME/data", "/tmp/%h/data", "/tmp/line\nbreak"])
    assert.throws(() => bridgeDropin(path, 8735));
});
