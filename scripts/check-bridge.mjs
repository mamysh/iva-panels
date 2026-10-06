// Optional integration check against an independently installed stock Iva checkout.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
const core = process.argv[2];
if (!core) throw new Error("Pass an isolated stock Iva checkout");
const directory = await mkdtemp(join(tmpdir(), "panels-bridge-"));
const servers = [];
const network = globalThis.fetch;
const calls = [];
const upstreamCalls = [];
let nextMessage = 1000;
let failNextEdit = false;
let child;
let exited;
async function stopService() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
}
async function listen(server) {
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
try {
  await mkdir(join(directory, "custom"));
  await writeFile(
    join(directory, "custom/plugins.json"),
    JSON.stringify({
      plugins: [
        {
          name: "bitrix24-read",
          enabled: true,
          trusted: true,
          sha: "synthetic",
        },
        { name: "file-delivery", enabled: true, trusted: true },
      ],
    }),
  );
  const upstream = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      upstreamCalls.push({ path: req.url, body });
      res.writeHead(204, { "x-iva-telegram-acceptance": "handled" });
      res.end();
    }),
  );
  const botOrigin = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const bytes of req) body += bytes;
      const method = req.url.slice(1);
      assert.notEqual(method, "getUpdates");
      calls.push({ method, body: JSON.parse(body) });
      if (method === "editMessageText" && failNextEdit) {
        failNextEdit = false;
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, description: "synthetic failure" }),
        );
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          result:
            method === "sendMessage" ? { message_id: nextMessage++ } : true,
        }),
      );
    }),
  );
  const reserve = createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const router = `http://127.0.0.1:${port}`;
  const panels = join(directory, "panels");
  await mkdir(panels, { mode: 0o700 });
  await writeFile(
    join(panels, "config.json"),
    JSON.stringify({
      upstream,
      secret: "synthetic-secret-123",
      botToken: "424242:synthetic",
      owners: [42],
      mode: "panels",
    }),
    { mode: 0o600 },
  );
  const preload = join(directory, "synthetic-telegram.mjs");
  await writeFile(
    preload,
    `const network=globalThis.fetch;globalThis.fetch=(url,init)=>{const u=new URL(String(url));if(u.hostname==='api.telegram.org')return network(process.env.SYNTHETIC_BOT_ORIGIN+'/'+u.pathname.split('/').at(-1),init);if(u.hostname!=='127.0.0.1')throw new Error('Unexpected external request');return network(url,init);};`,
  );
  async function startService() {
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        resolve("plugin/sh.iva/services/router/server.mjs"),
      ],
      {
        env: {
          ...process.env,
          PLUGIN_DATA: panels,
          IVA_DATA_DIR: directory,
          IVA_SERVICE_PORT: String(port),
          SYNTHETIC_BOT_ORIGIN: botOrigin,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    exited = once(child, "exit");
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await network(router + "/health");
        assert.equal(response.status, 200);
        break;
      } catch (error) {
        if (attempt >= 100 || child.exitCode !== null) throw error;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
  await startService();
  Object.assign(process.env, {
    ASSISTANT_DATA_DIR: directory,
    ASSISTANT_VAULT_DIR: join(directory, "vault"),
    ASSISTANT_HOST: router,
    TELEGRAM_BOT_TOKEN: "424242:synthetic",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "synthetic-secret-123",
    TELEGRAM_ALLOWED_USER_IDS: "42",
    TELEGRAM_POLL_SETTLE_MS: "0",
    TELEGRAM_COLLECT_QUIET_MS: "0",
    AGENT_LANGUAGE: "en",
  });
  globalThis.fetch = async (url, init) => {
    const address = new URL(String(url));
    if (address.hostname === "api.telegram.org") {
      const method = address.pathname.split("/").at(-1);
      assert.notEqual(method, "getUpdates");
      const body = JSON.parse(String(init?.body));
      calls.push({ method, body });
      return Response.json({
        ok: true,
        result: method === "sendMessage" ? { message_id: nextMessage++ } : true,
      });
    }
    assert.equal(address.hostname, "127.0.0.1");
    return network(url, init);
  };
  const load = (relative) =>
    import(pathToFileURL(resolve(core, relative)).href);
  const units = await load("scripts/lib/plugin-units.ts");
  const body = units.pluginServiceUnitBody({
    plugin: "iva-panels",
    service: "router",
    pluginRoot: resolve("plugin"),
    pluginData: panels,
    port,
    command: "bash",
    args: ["launch.sh"],
    nodeBinDir: resolve(process.execPath, ".."),
    dataDir: directory,
  });
  assert(
    body.includes(
      "WorkingDirectory=" + resolve("plugin/sh.iva/services/router"),
    ),
  );
  assert(body.includes("IVA_SERVICE_PORT"));
  assert(body.includes("PLUGIN_DATA"));
  assert(body.includes("launch.sh"));
  assert(!body.includes("synthetic-secret"));
  const main = await load("scripts/poller/main.ts");
  const inbox = await load("scripts/poller/inbox.ts");
  const status = await load("agent/lib/run-status.ts");
  const queue = await load("scripts/poller/queue.ts");
  let updateId = 10;
  const message = (text) => ({
    update_id: updateId++,
    message: {
      message_id: updateId + 100,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Synthetic" },
      chat: { id: 42, type: "private" },
      text,
    },
  });
  const tap = (data) => ({
    update_id: updateId++,
    callback_query: {
      id: `synthetic-${updateId}`,
      from: { id: 42, is_bot: false, first_name: "Synthetic" },
      data,
      message: {
        message_id: 1000,
        date: 1,
        from: { id: 424242, is_bot: true },
        chat: { id: 42, type: "private" },
      },
    },
  });
  async function accept(update) {
    const result = await main.processTelegramUpdate(update, 0, null);
    assert.equal(result.ingressBlocked, false);
    return update;
  }
  async function promote(options = {}) {
    await inbox.promoteReadyInbox({
      collectorOptions: { quietMs: 0 },
      ...options,
    });
  }
  await accept(message("/panels"));
  await promote();
  const opens = () =>
    calls.filter(
      (c) => c.method === "sendMessage" && c.body.text.startsWith("<b>Плагины"),
    );
  assert.equal(opens().length, 1);
  assert.equal(upstreamCalls.length, 0);
  const callback =
    opens()[0].body.reply_markup.inline_keyboard[0][0].callback_data;
  const click = tap(callback);
  await accept(click);
  await promote();
  assert.equal(click.message.message_id, 1000);
  assert.equal(click.message.from.id, 42);
  assert.equal(click.callback_query, undefined);
  assert(
    calls.some(
      (c) =>
        c.method === "editMessageText" &&
        c.body.message_id === 1000 &&
        c.body.text.startsWith("<b>Bitrix24"),
    ),
  );
  await stopService();
  await startService();
  await accept(structuredClone(click));
  await promote();
  assert.equal(opens().length, 1);
  assert.equal(
    calls.filter(
      (c) => c.method === "editMessageText" && c.body.message_id === 1000,
    ).length,
    1,
  );
  const back = calls.filter((c) => c.method === "editMessageText").at(-1).body
    .reply_markup.inline_keyboard[1][0].callback_data;
  status.setChatStatus("42:", {
    status: "running",
    sessionId: "synthetic",
    turnId: "synthetic",
  });
  await accept(tap(back));
  await promote();
  assert.equal((await queue.loadQueue()).queues["42:"].length, 1);
  assert.equal(
    calls.filter(
      (c) => c.method === "editMessageText" && c.body.message_id === 1000,
    ).length,
    1,
  );
  status.setChatStatus("42:", { status: "idle", sessionId: "synthetic" });
  await main.drainReadyQueueHeads();
  assert.equal((await queue.loadQueue()).queues["42:"]?.length ?? 0, 0);
  assert.equal(queue.queueInFlight.size, 0);
  const newChoice = calls
    .filter((c) => c.method === "editMessageText" && c.body.message_id === 1000)
    .at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  status.setChatStatus("42:", { status: "running", sessionId: "synthetic" });
  await accept(tap(newChoice));
  await promote();
  status.setChatStatus("42:", { status: "idle", sessionId: "synthetic" });
  failNextEdit = true;
  await main.drainReadyQueueHeads();
  assert.equal((await queue.loadQueue()).queues["42:"].length, 1);
  await stopService();
  await startService();
  await main.drainReadyQueueHeads();
  assert.equal((await queue.loadQueue()).queues["42:"]?.length ?? 0, 0);
  assert.equal(queue.queueInFlight.size, 0);
  assert.equal(opens().length, 1);

  await accept(message("ordinary synthetic message"));
  await promote();
  assert.equal(
    JSON.parse(upstreamCalls.at(-1).body).message.text,
    "ordinary synthetic message",
  );
  const native = {
    update_id: updateId++,
    callback_query: {
      id: "native",
      from: { id: 42, is_bot: false },
      data: "eve:synthetic",
      message: {
        message_id: 999,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 424242, is_bot: true },
      },
    },
  };
  await accept(native);
  await promote();
  assert.equal(
    JSON.parse(upstreamCalls.at(-1).body).callback_query.data,
    "eve:synthetic",
  );
  // Default collector must preserve ordinary text alongside a panel command.
  const before = upstreamCalls.length;
  await accept(message("/panels"));
  await accept(message("ordinary batched text"));
  await inbox.promoteReadyInbox({ now: () => Date.now() + 2000 });
  const forwarded = JSON.parse(upstreamCalls.at(-1).body);
  assert.equal(upstreamCalls.length, before + 1);
  assert.equal(forwarded.message.text, "ordinary batched text");
  assert.equal(forwarded.message.iva_parts, undefined);
  assert.match(forwarded.message.iva_durable_queue_receipt, /^[a-f0-9]{32}$/);
  await accept(message("ordinary first"));
  await accept(message("/panels"));
  await inbox.promoteReadyInbox({ now: () => Date.now() + 2000 });
  assert.equal(
    JSON.parse(upstreamCalls.at(-1).body).message.text,
    "ordinary first",
  );
  const commandsBefore = opens().length;
  await accept(message("/panels"));
  await accept(message("/panels"));
  await inbox.promoteReadyInbox({ now: () => Date.now() + 2000 });
  assert.equal(opens().length, commandsBefore + 2);
  const close = calls
    .filter((c) => c.method === "editMessageText" && c.body.message_id === 1000)
    .at(-1)
    .body.reply_markup.inline_keyboard.at(-1)
    .at(-1).callback_data;
  await accept(tap(close));
  await promote();
  assert(
    calls.some(
      (c) =>
        c.method === "editMessageText" &&
        c.body.message_id === 1000 &&
        c.body.text.includes("Панель закрыта"),
    ),
  );
  for (const path of ["/eve/v1/telegram/reset", "/eve/v1/telegram/cancel"]) {
    await network(router + path, { method: "POST", body: "{}" });
    assert.equal(upstreamCalls.at(-1).path, path);
  }

  console.log(
    "Bridge integration passed",
    execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  );
} finally {
  globalThis.fetch = network;
  await stopService();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await rm(directory, { recursive: true, force: true });
}
