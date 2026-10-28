import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import {
  Engine,
  type Delivery,
} from "../plugin/sh.iva/services/router/engine.ts";
import { Store } from "../plugin/sh.iva/services/router/store.ts";
import {
  parseAction,
  render,
  TTL,
  type Event,
  type View,
} from "../plugin/sh.iva/services/router/contracts.ts";
const home: View = {
  title: "Плагины",
  body: "Синтетический стенд",
  rows: [
    [{ id: "details", label: "Подробнее" }],
    [{ id: "close", label: "Закрыть" }],
  ],
};
const details: View = {
  title: "Сведения",
  body: "Внешний сервис не проверен",
  rows: [[{ id: "home", label: "Назад" }], [{ id: "close", label: "Закрыть" }]],
};
function event(
  id: number,
  text: string,
  message = 10,
  owner = 42,
  chat = 42,
): Event {
  return {
    update_id: id,
    message: {
      message_id: message,
      from: { id: owner, is_bot: false },
      chat: { id: chat, type: "private" },
      text,
    },
  };
}
async function fixture(t: { after(fn: () => Promise<unknown>): void }) {
  const path = await mkdtemp(join(tmpdir(), "panels-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  const calls: {
    kind: string;
    message?: number;
    payload: ReturnType<typeof render>;
  }[] = [];
  let failEdit = false,
    failSend = false,
    clock = 1000,
    renders = 0;
  const store = new Store(path);
  const provider = {
    async page(id: string) {
      renders++;
      return id === "home" ? home : details;
    },
  };
  const delivery: Delivery = {
    async send(_chat, payload) {
      calls.push({ kind: "send", payload });
      if (failSend) throw new Error("synthetic timeout");
      return 100;
    },
    async edit(_chat, message, payload) {
      calls.push({ kind: "edit", message, payload });
      if (failEdit) throw new Error("synthetic timeout");
    },
  };
  const fresh = () => new Engine(store, provider, delivery, () => clock);
  const engine = fresh();
  return {
    path,
    calls,
    store,
    engine,
    fresh,
    renders: () => renders,
    editFailure: (v: boolean) => {
      failEdit = v;
    },
    sendFailure: () => {
      failSend = true;
    },
    expire: () => {
      clock += TTL + 1;
    },
  };
}
test("one send then same-message edits with back and close", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const first =
    f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data;
  await f.engine.handle(event(2, first, 100));
  await f.engine.handle(
    event(
      3,
      f.calls[1].payload.reply_markup.inline_keyboard[0][0].callback_data,
      100,
    ),
  );
  await f.engine.handle(
    event(
      4,
      f.calls[2].payload.reply_markup.inline_keyboard[1][0].callback_data,
      100,
    ),
  );
  assert.deepEqual(
    f.calls.map((c) => c.kind),
    ["send", "edit", "edit", "edit"],
  );
  assert(f.calls.slice(1).every((c) => c.message === 100));
  assert.deepEqual(f.calls.at(-1)?.payload.reply_markup.inline_keyboard, []);
});
test("mutation intent is durable before dispatch; failed delivery and duplicate do not repeat effect", async (t) => {
  const f = await fixture(t);
  let effects = 0;
  const provider = f.engine.provider;
  const original = provider.page.bind(provider);
  provider.isMutation = (id) => id === "details";
  provider.recover = async () => details;
  provider.page = async (id) => {
    if (id === "details") {
      const state = await f.store.load();
      assert.equal(state.events["2"].phase, "acting");
      effects++;
    }
    return original(id);
  };
  await f.engine.handle(event(1, "/panels"));
  const click = event(
    2,
    f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data,
    100,
  );
  await f.engine.handle(event(8, click.message.text, 100, 99));
  await f.engine.handle(event(9, click.message.text, 999));
  assert.equal(effects, 0);
  f.editFailure(true);
  await assert.rejects(f.engine.handle(click));
  f.editFailure(false);
  await f.fresh().handle(click);
  await f.fresh().handle(click);
  assert.equal(effects, 1);
  assert.equal((await f.store.load()).events["2"].phase, "done");
});
test("crash after mutation but before saving view recovers by reading, never replays mutation", async (t) => {
  const f = await fixture(t);
  let effects = 0,
    reads = 0;
  f.engine.provider.isMutation = (id) => id === "details";
  const original = f.engine.provider.page.bind(f.engine.provider);
  f.engine.provider.page = async (id) => {
    if (id === "details") effects++;
    return original(id);
  };
  f.engine.provider.recover = async () => {
    reads++;
    return { ...details, body: "Результат прерванного запроса не подтверждён" };
  };
  await f.engine.handle(event(1, "/panels"));
  const click = event(
    2,
    f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data,
    100,
  );
  const save = f.store.save.bind(f.store);
  f.store.save = async (state) => {
    if (state.events["2"]?.phase === "editing")
      throw new Error("synthetic crash");
    return save(state);
  };
  await assert.rejects(f.engine.handle(click));
  assert.equal((await f.store.load()).events["2"].phase, "acting");
  f.store.save = save;
  await f.fresh().handle(click);
  assert.equal(effects, 1);
  assert.equal(reads, 1);
  assert.equal((await f.store.load()).events["2"].phase, "done");
});
test("duplicate command remains single-send across restart", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  await f.fresh().handle(event(1, "/panels"));
  assert.equal(f.calls.length, 1);
});
test("parallel duplicate commands are serialized", async (t) => {
  const f = await fixture(t);
  await Promise.all(
    Array.from({ length: 20 }, () => f.engine.handle(event(1, "/panels"))),
  );
  assert.equal(f.calls.length, 1);
});
test("failed edit replays only persisted delivery after restart", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const action = event(
    2,
    f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data,
    100,
  );
  f.editFailure(true);
  await assert.rejects(f.engine.handle(action));
  const count = f.renders();
  f.editFailure(false);
  await f.fresh().handle(action);
  assert.equal(f.renders(), count);
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.calls[1].payload, f.calls[2].payload);
});
test("unknown send outcome never posts replacement", async (t) => {
  const f = await fixture(t);
  f.sendFailure();
  await f.engine.handle(event(1, "/panels"));
  await f.fresh().handle(event(1, "/panels"));
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.load()).events["1"].phase, "uncertain");
});
test("interrupted sending intent is not automatically replayed", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const state = await f.store.load();
  state.events["1"].phase = "sending";
  await f.store.save(state);
  await f.fresh().handle(event(1, "/panels"));
  assert.equal(f.calls.length, 1);
  assert.equal((await f.store.load()).events["1"].phase, "uncertain");
});
test("same update ID with different content is refused", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  await assert.rejects(
    f.engine.handle(event(1, "ipanel:unknown")),
    /EVENT_COLLISION/,
  );
});
test("different owner, chat or message cannot operate screen", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const action =
    f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data;
  for (const e of [
    event(2, action, 100, 99),
    event(3, action, 100, 42, 99),
    event(4, action, 101),
  ])
    await f.engine.handle(e);
  assert.equal(f.calls.length, 1);
});
test("expired screen rejects callback", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  f.expire();
  await f.engine.handle(
    event(
      2,
      f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data,
      100,
    ),
  );
  assert.equal(f.calls.length, 1);
});
test("closed and stale choices cannot be reused", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const choices = f.calls[0].payload.reply_markup.inline_keyboard;
  await f.engine.handle(event(2, choices[1][0].callback_data, 100));
  await f.engine.handle(event(3, choices[0][0].callback_data, 100));
  assert.equal(f.calls.length, 2);
});
test("pending edit blocks a different action until delivery recovers", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const c = f.calls[0].payload.reply_markup.inline_keyboard;
  f.editFailure(true);
  await assert.rejects(f.engine.handle(event(2, c[0][0].callback_data, 100)));
  await f.engine.handle(event(3, c[1][0].callback_data, 100));
  assert.equal(f.calls.length, 2);
});
test("corrupt state fails closed; never silently resets", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.path, "screens.json"), "{broken");
  await assert.rejects(f.engine.handle(event(1, "/panels")), /INVALID_STATE/);
  assert.equal(f.calls.length, 0);
});
test("state is private and excludes full inbound messages", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const path = join(f.path, "screens.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const text = await readFile(path, "utf8");
  assert(!text.includes("from"));
  assert(!text.includes("botToken"));
});
test("property: arbitrary stale revisions never dispatch", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(1, "/panels"));
  const action = parseAction(
    f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data,
  )!;
  let id = 1;
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 1, max: 100000 }), async (revision) => {
      await f.engine.handle(
        event(++id, `ipanel:${action.screen}:${revision}:0`, 100),
      );
      assert.equal(f.calls.length, 1);
    }),
    { seed: 20261007, numRuns: 100 },
  );
});
test("property: button callback byte budget and literal HTML text", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 200 }), (text) => {
      const payload = render({ ...home, body: text }, "a".repeat(24), 99999999);
      assert(!payload.text.includes("<script>"));
      for (const row of payload.reply_markup.inline_keyboard)
        for (const b of row) {
          assert(Buffer.byteLength(b.callback_data) <= 64);
          assert(parseAction(b.callback_data));
        }
    }),
    { seed: 20261007, numRuns: 100 },
  );
});
test("regrouped command retains identity and distinct batch commands both open", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(100, "/panels", 10), 0);
  await f.fresh().handle(event(101, "/panels", 10), 1);
  assert.equal(f.calls.length, 1);
  await f.engine.handle(event(101, "/panels", 11), 2);
  assert.equal(f.calls.length, 2);
});
test("regrouped pending edit retries saved delivery without rendering again", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(100, "/panels", 10));
  const choice =
    f.calls[0].payload.reply_markup.inline_keyboard[0][0].callback_data;
  f.editFailure(true);
  await assert.rejects(f.engine.handle(event(101, choice, 100), 0));
  const renders = f.renders();
  f.editFailure(false);
  await f.fresh().handle(event(102, choice, 100), 1);
  assert.equal(f.renders(), renders);
  assert.equal(f.calls.filter((c) => c.kind === "send").length, 1);
});
test("partial Bridge acknowledgement can shift a part index under the same batch ID", async (t) => {
  const f = await fixture(t);
  await f.engine.handle(event(100, "/panels", 10), 0);
  await f.engine.handle(event(100, "/panels", 11), 1);
  await f.fresh().handle(event(100, "/panels", 11), 0);
  assert.equal(f.calls.filter((c) => c.kind === "send").length, 2);
});

test("explicit shortcut opens one bound screen and duplicate delivery never opens it again", async (t) => {
  const f = await fixture(t);
  const seen: string[] = [];
  f.engine.provider.page = async (id) => {
    seen.push(id);
    return details;
  };
  const command = event(1, "/panels home");
  await f.engine.handle(command);
  await f.fresh().handle(command);
  assert.equal(f.calls.length, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^open:[a-f0-9]{24}$/);
  const screen = Object.values((await f.store.load()).screens)[0];
  assert.equal(screen.page, seen[0]);
  assert.equal(screen.owner, 42);
  assert.equal(screen.message, 100);
});
