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
  const seen: unknown[] = [];
  let handled = 0;
  const proxy = await listen(
    createRouter(config, {
      async handle(event) {
        handled++;
        seen.push(event);
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
  return { proxy, calls, post, seen, handled: () => handled };
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
test("mixed Bridge batch forwards only ordinary parts and preserves queue receipt", async (t) => {
  for (const reversed of [false, true]) {
    const f = await setup(t);
    const own = input().message;
    const normal = input("ordinary").message;
    normal.message_id = 20;
    const message = {
      ...(reversed ? normal : own),
      iva_parts: reversed ? [normal, own] : [own, normal],
      iva_durable_queue_receipt: "1234567890abcdef1234567890abcdef",
    };
    const result = await f.post({ update_id: 50, message });
    assert.equal(result.status, 204);
    assert.equal(f.handled(), 1);
    const forwarded = JSON.parse(f.calls[0].body);
    assert.equal(forwarded.message.text, "ordinary");
    assert.equal(forwarded.message.message_id, 20);
    assert.equal(forwarded.message.iva_parts, undefined);
    assert.equal(
      forwarded.message.iva_durable_queue_receipt,
      message.iva_durable_queue_receipt,
    );
    assert.equal(forwarded.update_id, 50);
  }
});
test("own-only batch dispatches each part and never reaches Eve", async (t) => {
  const f = await setup(t);
  const a = input().message,
    b = { ...a, message_id: 20 };
  const result = await f.post({
    update_id: 55,
    message: { ...a, iva_parts: [a, b] },
  });
  assert.equal(result.status, 204);
  assert.equal(f.handled(), 2);
  assert.equal(f.calls.length, 0);
});

function callback(
  from = { id: 42, is_bot: false },
  chat = { id: 42, type: "private" },
  data = "iva_panels:" + "a".repeat(24) + ":0:0",
) {
  return {
    update_id: 7,
    callback_query: {
      id: "synthetic-callback",
      data,
      from,
      message: { message_id: 10, from: { id: 100, is_bot: true }, chat },
    },
  };
}
test("reserved callback envelope uses tapping owner and message, without an Eve turn", async (t) => {
  const f = await setup(t);
  const r = await f.post(callback());
  assert.equal(r.status, 204);
  assert.equal(f.handled(), 1);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.seen[0], {
    update_id: 7,
    callback_query: callback().callback_query,
    message: {
      message_id: 10,
      chat: { id: 42, type: "private" },
      from: { id: 42, is_bot: false },
      text: callback().callback_query.data,
    },
  });
});
test("raw callbacks reject foreign owner, group, bot and unauthenticated input", async (t) => {
  const f = await setup(t);
  for (const value of [
    callback({ id: 43, is_bot: false }),
    callback({ id: 42, is_bot: true }),
    callback(undefined, { id: 42, type: "group" }),
  ])
    assert.equal((await f.post(value)).status, 403);
  assert.equal(
    (await f.post(callback(), undefined, "wrong-secret")).status,
    403,
  );
  assert.equal(f.handled(), 0);
});
test("foreign callback is forwarded byte for byte", async (t) => {
  const f = await setup(t);
  const value = callback(undefined, undefined, "eve:other");
  await f.post(value);
  assert.equal(f.handled(), 0);
  assert.equal(f.calls[0].body, JSON.stringify(value));
});
