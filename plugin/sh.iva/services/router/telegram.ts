import type { Delivery } from "./engine.ts";
export function telegram(token: string): Delivery {
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
      const result = await call("sendMessage", { chat_id: chat, ...payload });
      if (!Number.isSafeInteger(result.message_id))
        throw new Error("UNKNOWN_SEND");
      return result.message_id!;
    },
    async edit(chat, message, payload) {
      await call("editMessageText", {
        chat_id: chat,
        message_id: message,
        ...payload,
      });
    },
  };
}
