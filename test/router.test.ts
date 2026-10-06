import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { createRouter } from "../plugin/sh.iva/services/router/router.ts";
import { configSchema } from "../plugin/sh.iva/services/router/contracts.ts";
async function listen(
  server: Server,
  t: { after(fn: () => Promise<unknown>): void },
) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });
  const a = server.address();
  assert(a && typeof a !== "string");
  return `http://127.0.0.1:${a.port}`;
}
function input(text = "/panels") {
  return {
    update_id: 1,
    message: {
      message_id: 10,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      text,
    },
  };
}
async function setup(
  t: { after(fn: () => Promise<unknown>): void },
  mode = "panels",
  handle: () => Promise<void> = async () => {},
) {
  const calls: { path: string; body: string; secret: unknown }[] = [];
  const upstream = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const bytes of req) body += bytes;
      calls.push({
        path: req.url!,
        body,
        secret: req.headers["x-telegram-bot-api-secret-token"],
      });
      res.writeHead(204, { "x-iva-telegram-acceptance": "turn" });
      res.end();
    }),
    t,
  );
  const config = configSchema.parse({
    upstream,
    mode,
    secret: "synthetic-secret-123",
    botToken: "424242:synthetic",
    owners: [42],
  });
  let handled = 0;
  const proxy = await listen(
    createRouter(config, {
      async handle() {
        handled++;
        await handle();
      },
    }),
    t,
  );
  const post = (
    value: unknown,
    path = "/eve/v1/telegram/accepted",
    secret = config.secret,
  ) =>
    fetch(proxy + path, {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify(value),
    });
  return { proxy, calls, post, handled: () => handled };
}
test("own command is handled without Eve turn", async (t) => {
  const f = await setup(t);
  const r = await f.post(input());
  assert.equal(r.status, 204);
  assert.equal(r.headers.get("x-iva-telegram-acceptance"), "handled");
  assert.equal(f.calls.length, 0);
});
test("normal messages preserve body and acceptance receipt", async (t) => {
  const f = await setup(t);
  const value = input("hello");
  const r = await f.post(value);
  assert.equal(r.headers.get("x-iva-telegram-acceptance"), "turn");
  assert.equal(f.calls[0].body, JSON.stringify(value));
  assert.equal(f.calls[0].secret, "synthetic-secret-123");
});
test("passthrough mode does not claim panel commands", async (t) => {
  const f = await setup(t, "passthrough");
  await f.post(input());
  assert.equal(f.handled(), 0);
  assert.equal(f.calls.length, 1);
});
test("reset, cancel, callback and query paths are forwarded", async (t) => {
  const f = await setup(t);
  for (const path of [
    "/eve/v1/telegram/reset",
    "/eve/v1/telegram/cancel",
    "/eve/v1/telegram/accepted?query=1",
  ]) {
    await f.post(input(), path);
    assert.equal(f.calls.at(-1)?.path, path);
  }
  await f.post({ callback_query: { data: "eve:1" } });
  assert.equal(f.handled(), 0);
});
test("invalid own event secret or owner is refused", async (t) => {
  const f = await setup(t);
  assert.equal((await f.post(input(), undefined, "wrong")).status, 403);
  const e = input();
  e.message.from.id = 99;
  assert.equal((await f.post(e)).status, 403);
  assert.equal(f.handled(), 0);
  assert.equal(f.calls.length, 0);
});
test("group and bot inputs are refused", async (t) => {
  const f = await setup(t);
  const group = input();
  group.message.chat.type = "group";
  assert.equal((await f.post(group)).status, 403);
  const bot = input();
  bot.message.from.is_bot = true;
  assert.equal((await f.post(bot)).status, 403);
});
test("invalid action in own namespace never falls through to model", async (t) => {
  const f = await setup(t);
  assert.equal((await f.post(input("ipanel:not-valid"))).status, 204);
  assert.equal(f.calls.length, 0);
});
test("failed own handler gets 503 without forwarding", async (t) => {
  const f = await setup(t, "panels", async () => {
    throw new Error("synthetic");
  });
  assert.equal((await f.post(input())).status, 503);
  assert.equal(f.calls.length, 0);
});
test("compressed upstream response is forwarded as original bytes", async (t) => {
  const compressed = gzipSync("synthetic response");
  const upstream = await listen(
    createServer((_req, res) => {
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(compressed.length),
      });
      res.end(compressed);
    }),
    t,
  );
  const config = configSchema.parse({
    upstream,
    mode: "passthrough",
    secret: "synthetic-secret-123",
    botToken: "424242:synthetic",
    owners: [42],
  });
  const proxy = await listen(createRouter(config, { async handle() {} }), t);
  const result = await new Promise<Buffer>((resolve, reject) => {
    request(proxy + "/other", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (b) => chunks.push(b));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    })
      .on("error", reject)
      .end();
  });
  assert.deepEqual(result, compressed);
});
test("config rejects remote, self-contained credentials and paths; mode defaults off", () => {
  const baseline = {
    secret: "synthetic-secret-123",
    botToken: "424242:synthetic",
    owners: [42],
  };
  for (const upstream of [
    "https://example.invalid",
    "http://a:b@127.0.0.1:1234",
    "http://127.0.0.1:1234/path",
  ])
    assert.equal(
      configSchema.safeParse({ ...baseline, upstream }).success,
      false,
    );
  assert.equal(
    configSchema.parse({ ...baseline, upstream: "http://127.0.0.1:1234" }).mode,
    "passthrough",
  );
});
