import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

async function fixture(
  t: { after(fn: () => Promise<unknown>): void },
  mode: number,
  launcher = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "panels-service-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const upstream = createServer((_req, res) => {
    res.writeHead(204, { "x-iva-telegram-acceptance": "turn" });
    res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const reserve = createServer();
  await new Promise<void>((r) => reserve.listen(0, "127.0.0.1", r));
  const allocated = reserve.address();
  assert(allocated && typeof allocated !== "string");
  const port = allocated.port;
  await new Promise<void>((r) => reserve.close(() => r()));
  await writeFile(
    join(directory, "config.json"),
    JSON.stringify({
      upstream: `http://127.0.0.1:${address.port}`,
      secret: "synthetic-secret-123",
      botToken: "424242:synthetic",
      owners: [42],
    }),
    { mode },
  );
  const child = spawn(
    launcher ? "bash" : process.execPath,
    [
      resolve(
        launcher
          ? "plugin/sh.iva/services/router/launch.sh"
          : "plugin/sh.iva/services/router/server.mjs",
      ),
    ],
    {
      cwd: launcher ? resolve("plugin/sh.iva/services/router") : process.cwd(),
      env: {
        ...process.env,
        PLUGIN_DATA: directory,
        IVA_DATA_DIR: directory,
        IVA_SERVICE_PORT: String(port),
        PLUGIN_ROOT: resolve("plugin"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  });
  return { child, exited, port, directory, logs: () => logs };
}
test(
  "standalone distribution starts with private config and transparently forwards",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, 0o600);
    for (let attempt = 0; ; attempt++) {
      try {
        const health = await fetch(`http://127.0.0.1:${f.port}/health`);
        assert.equal((await health.json()).mode, "passthrough");
        break;
      } catch (error) {
        if (attempt >= 50 || f.child.exitCode !== null) throw error;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const response = await fetch(
      `http://127.0.0.1:${f.port}/eve/v1/telegram/accepted`,
      {
        method: "POST",
        body: JSON.stringify({ message: { text: "/panels" } }),
      },
    );
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("x-iva-telegram-acceptance"), "turn");
    assert(!f.logs().includes("synthetic-secret"));
    assert(!f.logs().includes("424242"));
  },
);
test(
  "standalone distribution refuses readable config without exposing secrets",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, 0o644);
    const [code] = await f.exited;
    assert.equal(code, 1);
    assert.match(f.logs(), /startup failed/);
    assert(!f.logs().includes("synthetic-secret"));
    assert(!f.logs().includes("424242"));
  },
);

test(
  "Linux launcher refuses a concurrent instance and releases its lock after exit",
  { skip: process.platform !== "linux", timeout: 10000 },
  async (t) => {
    const f = await fixture(t, 0o600, true);
    for (let attempt = 0; ; attempt++) {
      try {
        assert.equal(
          (await fetch(`http://127.0.0.1:${f.port}/health`)).status,
          200,
        );
        break;
      } catch (error) {
        if (attempt >= 50) throw error;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    const second = spawn(
      "bash",
      [resolve("plugin/sh.iva/services/router/launch.sh")],
      {
        cwd: resolve("plugin/sh.iva/services/router"),
        env: {
          ...process.env,
          PLUGIN_ROOT: resolve("plugin"),
          PLUGIN_DATA: f.directory,
          IVA_DATA_DIR: f.directory,
          IVA_SERVICE_PORT: String(f.port),
        },
        stdio: "ignore",
      },
    );
    const [code] = await once(second, "exit");
    assert.equal(code, 1);
    f.child.kill("SIGTERM");
    await f.exited;
    const third = spawn(
      "bash",
      [resolve("plugin/sh.iva/services/router/launch.sh")],
      {
        cwd: resolve("plugin/sh.iva/services/router"),
        env: {
          ...process.env,
          PLUGIN_ROOT: resolve("plugin"),
          PLUGIN_DATA: f.directory,
          IVA_DATA_DIR: f.directory,
          IVA_SERVICE_PORT: String(f.port),
        },
        stdio: "ignore",
      },
    );
    const done = once(third, "exit");
    t.after(async () => {
      if (third.exitCode === null && third.signalCode === null) {
        third.kill("SIGTERM");
        await done;
      }
    });
    for (let attempt = 0; ; attempt++) {
      try {
        assert.equal(
          (await fetch(`http://127.0.0.1:${f.port}/health`)).status,
          200,
        );
        break;
      } catch (error) {
        if (attempt >= 50) throw error;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  },
);
