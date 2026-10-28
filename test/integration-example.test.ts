import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  DynamicPanels,
  dynamicReadId,
  socketCall,
} from "../plugin/sh.iva/services/router/dynamic.ts";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
import { cardId } from "../plugin/sh.iva/services/router/catalog.ts";
import { Engine } from "../plugin/sh.iva/services/router/engine.ts";
import { Store } from "../plugin/sh.iva/services/router/store.ts";
import { serveChatCards } from "../plugin/sh.iva/services/router/chat-cards.ts";
import type { render } from "../plugin/sh.iva/services/router/contracts.ts";

import { inspectIntegration } from "../plugin/sh.iva/services/router/integration.ts";
const name = "dynamic-notes-example";
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const done = once(child, "exit");
  child.kill("SIGTERM");
  const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
  try {
    await done;
  } finally {
    clearTimeout(kill);
  }
}
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const data = await realpath(await mkdtemp("/tmp/pi-"));
  const root = join(data, "custom/plugins", name);
  const directory = join(data, "plugin-data", name);
  const panelsData = join(data, "plugin-data/iva-panels");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(panelsData, { recursive: true, mode: 0o700 });
  await cp(resolve("examples/dynamic-notes"), root, { recursive: true });
  await writeFile(
    join(data, "custom/plugins.json"),
    JSON.stringify({
      plugins: [{ name, enabled: true, trusted: true, sha: "a".repeat(40) }],
    }),
  );
  const call = socketCall(data);
  let child: ChildProcess;
  async function start() {
    child = spawn(
      process.execPath,
      [join(root, "sh.iva/services/panels/server.mjs")],
      {
        env: { PATH: process.env.PATH, PLUGIN_DATA: directory },
        stdio: "ignore",
      },
    );
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error("Example process exited");
      try {
        await call(name, "1.0.0", { op: "read", page: "home" });
        return;
      } catch {
        await delay(20);
      }
    }
    throw new Error("Example did not become ready");
  }
  t.after(async () => {
    if (child) await stop(child);
    await rm(data, { recursive: true, force: true });
  });
  await start();
  function provider() {
    return installedPanels(
      data,
      false,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      new DynamicPanels(data, panelsData),
    );
  }
  return {
    data,
    directory,
    panelsData,
    call,
    provider,
    async restart() {
      await stop(child);
      await start();
    },
    async state() {
      return JSON.parse(
        await readFile(join(directory, "panels-settings.json"), "utf8"),
      );
    },
  };
}

test(
  "unmodified packaged plugin in another process: generic discovery, cancel, confirm and persistent receipt",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    await writeFile(
      join(f.panelsData, "config.json"),
      JSON.stringify({
        upstream: "http://127.0.0.1:9000",
        secret: "synthetic-secret-123",
        botToken: "42:synthetic",
        owners: [42],
        mode: "panels",
        dynamicPanels: true,
      }),
      { mode: 0o600 },
    );
    const inspected = await promisify(execFile)(
      process.execPath,
      [resolve("plugin/sh.iva/services/router/inspect.mjs"), f.data, name],
      { cwd: f.panelsData, env: { PATH: process.env.PATH } },
    );
    assert.equal(
      JSON.parse(inspected.stdout).state,
      "ready",
      "packaged diagnostic must run outside a checkout without npm",
    );
    const baseline = await f.state();
    assert.equal((await inspectIntegration(f.data, name, true)).state, "ready");
    assert.deepEqual(
      await f.state(),
      baseline,
      "diagnostic read must not change settings or receipts",
    );
    let provider = f.provider();
    const card = await provider.page(cardId(name));
    assert(card.rows.flat().some((b) => b.id === dynamicReadId(name, "home")));
    const screen = await provider.page(dynamicReadId(name, "home"));
    assert.match(screen.body, /выключен/);
    const offer = await provider.page(screen.rows[0][0].id);
    assert.equal((await f.state()).settings.compact, false);
    await provider.page(offer.rows[0][1].id);
    assert.equal((await f.state()).revision, 0);
    const next = await provider.page(screen.rows[0][0].id);
    const confirm = next.rows[0][0].id;
    const token = confirm.split(":")[3];
    await provider.page(confirm);
    assert.equal((await f.state()).settings.compact, true);
    assert.equal((await f.state()).revision, 1);
    await f.restart();
    provider = f.provider();
    await provider.page(confirm);
    const result = await f.call(name, "1.0.0", { op: "confirm", token });
    assert.equal((result as { state: string }).state, "done");
    assert.equal((await f.state()).revision, 1);
    assert.match(
      (await provider.page(dynamicReadId(name, "home"))).body,
      /включён/,
    );
    // The plugin's API and settings remain usable without a Panels process.
    assert.equal(
      (
        (await f.call(name, "1.0.0", { op: "read", page: "home" })) as {
          revision: number;
        }
      ).revision,
      1,
    );
  },
);

test(
  "packaged plugin presents through the real chat socket; bound callback confirms once after both restarts",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    let sends = 0;
    let payload: ReturnType<typeof render>;
    const delivery = {
      async send(_chat: number, value: ReturnType<typeof render>) {
        sends++;
        payload = value;
        return 20;
      },
      async edit() {},
    };
    const store = new Store(f.panelsData);
    let engine = new Engine(store, f.provider(), delivery);
    const cards = await serveChatCards(
      f.panelsData,
      { issue: (...args) => engine.issue(...args) },
      [42],
    );
    t.after(() => new Promise<void>((r) => cards.close(() => r())));
    const input = {
      schema: "iva-panels/chat-v1",
      plugin: name,
      action: "toggle-compact",
      revision: 0,
      requestId: "c".repeat(24),
    };
    const present = () =>
      new Promise<{ state: string }>((resolve, reject) => {
        const req = request(
          {
            socketPath: join(f.panelsData, "chat.sock"),
            path: "/cards/v1",
            method: "POST",
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
              try {
                assert.equal(res.statusCode, 200);
                resolve(JSON.parse(Buffer.concat(chunks).toString()));
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(input));
      });
    assert.equal((await present()).state, "presented");
    assert.equal((await f.state()).revision, 0);
    await f.restart();
    engine = new Engine(store, f.provider(), delivery);
    assert.equal((await present()).state, "already_presented");
    assert.equal(sends, 1);
    const text = payload!.reply_markup.inline_keyboard[0][0].callback_data;
    const event = (id: number, message: number, owner = 42) => ({
      update_id: id,
      message: {
        message_id: message,
        from: { id: owner, is_bot: false as const },
        chat: { id: 42, type: "private" as const },
        text,
      },
    });
    await engine.handle(event(1, 21));
    await engine.handle(event(2, 20, 43));
    assert.equal((await f.state()).revision, 0);
    await engine.handle(event(3, 20));
    await engine.handle(event(3, 20));
    assert.equal((await f.state()).settings.compact, true);
    assert.equal((await f.state()).revision, 1);
    assert.equal(sends, 1);
  },
);
