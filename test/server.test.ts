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
    process.execPath,
    [resolve("plugin/sh.iva/services/router/server.mjs")],
    {
      env: {
        ...process.env,
        PLUGIN_DATA: directory,
        IVA_DATA_DIR: directory,
        IVA_SERVICE_PORT: String(port),
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
  return { child, exited, port, logs: () => logs };
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
