import { test } from "node:test";
import assert from "node:assert/strict";
import { telegram } from "../plugin/sh.iva/services/router/telegram.ts";
import { render } from "../plugin/sh.iva/services/router/contracts.ts";
const payload = {
  text: "synthetic",
  parse_mode: "HTML" as const,
  reply_markup: { inline_keyboard: [] },
};
test("Bot API adapter sends targeted payload and accepts unchanged edit", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return calls.length === 1
      ? Response.json({ ok: true, result: { message_id: 12 } })
      : Response.json(
          { ok: false, description: "Bad Request: message is not modified" },
          { status: 400 },
        );
  };
  const delivery = telegram("424242:synthetic");
  assert.equal(await delivery.send(42, payload), 12);
  await delivery.edit(42, 12, payload);
  assert(calls[0].url.endsWith("/sendMessage"));
  assert(calls[1].url.endsWith("/editMessageText"));
  assert.equal(calls[1].body.message_id, 12);
  assert.equal(calls[1].body.chat_id, 42);
});
test("rich cards use block buttons, escaped text and same-message edits without a second send", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({
      method: String(url).split("/").at(-1)!,
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ ok: true, result: { message_id: 12 } });
  };
  const view = {
    title: "<unsafe>",
    body: "<tg-button>data</tg-button>",
    rows: [[{ id: "close", label: "Закрыть <unsafe>" }]],
  };
  const p = render(view, "a".repeat(24), 0);
  const delivery = telegram("424242:synthetic", "rich");
  assert.equal(await delivery.send(42, p), 12);
  await delivery.edit(42, 12, p);
  assert.deepEqual(
    calls.map((c) => c.method),
    ["sendRichMessage", "editMessageText"],
  );
  const rich = calls[0].body.rich_message as { html: string };
  assert(rich.html.includes("<tg-button-row>"));
  assert(rich.html.includes('style="danger"'));
  assert(rich.html.includes("&lt;unsafe&gt;"));
  assert(!rich.html.includes("<unsafe>"));
  assert(!rich.html.includes("<tg-button>data"));
  assert(!("text" in calls[0].body));
  assert.equal(calls[1].body.message_id, 12);
  assert.deepEqual(calls[1].body.reply_markup, { inline_keyboard: [] });
});
test("Bot API adapter rejects error responses and unknown sends", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  globalThis.fetch = async () =>
    Response.json(
      { ok: false, description: "private response" },
      { status: 403 },
    );
  await assert.rejects(telegram("424242:synthetic").edit(42, 12, payload), {
    message: "TELEGRAM_DELIVERY_FAILED",
  });
  globalThis.fetch = async () => Response.json({ ok: true, result: {} });
  await assert.rejects(telegram("424242:synthetic").send(42, payload), {
    message: "UNKNOWN_SEND",
  });
});
