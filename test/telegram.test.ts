import { test } from "node:test";
import assert from "node:assert/strict";
import { telegram } from "../plugin/sh.iva/services/router/telegram.ts";
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
