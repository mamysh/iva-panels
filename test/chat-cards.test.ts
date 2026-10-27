import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath, stat } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { Engine } from "../plugin/sh.iva/services/router/engine.ts";
import { Store } from "../plugin/sh.iva/services/router/store.ts";
import { serveChatCards } from "../plugin/sh.iva/services/router/chat-cards.ts";
import { render } from "../plugin/sh.iva/services/router/contracts.ts";

test("chat card is prepared and delivered once; only the bound owner's actual message can confirm", async (t) => {
  const dir = await realpath(await mkdtemp("/tmp/cc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let sends = 0,
    writes = 0;
  let payload: ReturnType<typeof render>;
  const provider = {
    async page(id: string) {
      if (id === "confirm") writes++;
      return {
        title: "Проверка",
        body: "Имя: Synthetic\nEmail: example@example.test",
        rows:
          id === "confirm"
            ? []
            : [
                [
                  { id: "confirm", label: "Подтвердить" },
                  { id: "close", label: "Отмена" },
                ],
              ],
      };
    },
    isMutation: (id: string) => id === "confirm",
  };
  const delivery = {
    async send(_chat: number, p: ReturnType<typeof render>) {
      sends++;
      payload = p;
      return 20;
    },
    async edit() {},
  };
  const store = new Store(dir),
    engine = new Engine(store, provider, delivery);
  const id = "a".repeat(24);
  assert.deepEqual(await engine.issue(id, "prepare", 42), {
    state: "presented",
  });
  assert.equal(writes, 0);
  assert.equal(sends, 1);
  const restarted = new Engine(store, provider, delivery);
  await restarted.issue(id, "prepare", 42);
  assert.equal(sends, 1);
  const text = payload!.reply_markup.inline_keyboard[0][0].callback_data;
  const event = (update_id: number, message = 20, owner = 42) => ({
    update_id,
    message: {
      message_id: message,
      from: { id: owner, is_bot: false as const },
      chat: { id: 42, type: "private" as const },
      text,
    },
  });
  await restarted.handle(event(1, 21));
  await restarted.handle(event(2, 20, 43));
  assert.equal(writes, 0);
  await restarted.handle(event(3));
  await restarted.handle(event(3));
  assert.equal(writes, 1);
  assert.match(payload!.text, /<b>Имя:<\/b> Synthetic/);
});

test("unknown send is durable and cannot be replayed after restart", async (t) => {
  const dir = await realpath(await mkdtemp("/tmp/cc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let sends = 0;
  const store = new Store(dir),
    provider = {
      async page() {
        return { title: "Test", body: "", rows: [] };
      },
    },
    delivery = {
      async send() {
        sends++;
        throw new Error("response lost");
      },
      async edit() {},
    };
  assert.deepEqual(
    await new Engine(store, provider, delivery).issue(
      "b".repeat(24),
      "prepare",
      42,
    ),
    { state: "delivery_unknown" },
  );
  assert.deepEqual(
    await new Engine(store, provider, delivery).issue(
      "b".repeat(24),
      "prepare",
      42,
    ),
    { state: "delivery_unknown" },
  );
  assert.equal(sends, 1);
});

test("private chat socket accepts only prepare requests and never caller-provided recipients", async (t) => {
  const dir = await realpath(await mkdtemp("/tmp/cc-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: unknown[] = [];
  const engine = {
    async issue(...v: unknown[]) {
      calls.push(v);
      return { state: "presented" };
    },
  };
  const server = await serveChatCards(dir, engine, [42]);
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  assert.equal((await stat(join(dir, "chat.sock"))).mode & 0o777, 0o600);
  const send = (v: unknown) =>
    new Promise<number>((resolve, reject) => {
      const req = request(
        {
          socketPath: join(dir, "chat.sock"),
          path: "/cards/v1",
          method: "POST",
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(v));
    });
  const input = {
    schema: "iva-panels/chat-v1",
    plugin: "notes",
    action: "set-mode",
    revision: 0,
    requestId: "c".repeat(24),
  };
  assert.equal(await send({ ...input, owner: 99 }), 400);
  assert.equal(await send({ ...input, op: "confirm" }), 400);
  assert.equal(calls.length, 0);
  assert.equal(await send(input), 200);
  assert.equal(calls.length, 1);
  assert.equal((calls[0] as unknown[])[2], 42);
});
