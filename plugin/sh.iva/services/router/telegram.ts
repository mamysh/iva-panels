import type { Delivery } from "./engine.ts";
import { escape, type render } from "./contracts.ts";
export function richPayload(payload: ReturnType<typeof render>) {
  const rows = payload.reply_markup.inline_keyboard.map(
    (row) =>
      `<tg-button-row>${row.map((button) => `<tg-button type="callback_data"${button.style ? ` style="${button.style}"` : ""} data="${button.callback_data}">${escape(button.text)}</tg-button>`).join("")}</tg-button-row>`,
  );
  // render() already escaped title/body as literal HTML. Only our own markup is added.
  return {
    rich_message: {
      html: `<p>${payload.text.replace(/\n/g, "<br>")}</p>${rows.join("")}`,
    },
  };
}
export function telegram(
  token: string,
  presentation: "classic" | "rich" = "classic",
): Delivery {
  async function call(method: string, payload: unknown) {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    const result = (await response.json()) as {
      ok?: boolean;
      result?: { message_id?: number };
      description?: string;
    };
    if (!response.ok || !result.ok) {
      if (
        method === "editMessageText" &&
        response.status === 400 &&
        result.description?.includes("message is not modified")
      )
        return {};
      // Never expose response content, URL or token in an error or log.
      throw new Error("TELEGRAM_DELIVERY_FAILED");
    }
    return result.result ?? {};
  }
  return {
    async send(chat, payload) {
      const result = await call(
        presentation === "rich" ? "sendRichMessage" : "sendMessage",
        {
          chat_id: chat,
          ...(presentation === "rich" ? richPayload(payload) : payload),
        },
      );
      if (!Number.isSafeInteger(result.message_id))
        throw new Error("UNKNOWN_SEND");
      return result.message_id!;
    },
    async edit(chat, message, payload) {
      await call("editMessageText", {
        chat_id: chat,
        message_id: message,
        ...(presentation === "rich"
          ? { ...richPayload(payload), reply_markup: { inline_keyboard: [] } }
          : payload),
      });
    },
  };
}

// Ack is cosmetic, never a reason to replay an already processed action.
export async function acknowledgeCallback(token: string, id: string) {
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: id }),
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  }).catch(() => {});
}
