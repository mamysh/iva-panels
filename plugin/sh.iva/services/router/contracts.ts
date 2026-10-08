import { z } from "zod";
export const VERSION = "0.1.0";
export const PREFIX = "iva_panels:";
const LEGACY_PREFIX = "ipanel:";
export const ACCEPTANCE = "x-iva-telegram-acceptance";
export const TTL = 15 * 60_000;
export const LIMITS = {
  screens: 100,
  events: 500,
  body: 1024 * 1024,
  page: 3500,
};
export const actionSchema = z
  .object({ id: z.string().min(1).max(80), label: z.string().min(1).max(64) })
  .strict();
export const viewSchema = z
  .object({
    title: z.string().min(1).max(160),
    body: z.string().max(2500),
    rows: z.array(z.array(actionSchema).min(1).max(2)).max(8),
  })
  .strict()
  .refine(
    (v) =>
      new Set(v.rows.flat().map((a) => a.id)).size === v.rows.flat().length,
  );
export type View = z.infer<typeof viewSchema>;
export const eventSchema = z
  .object({
    update_id: z.number().int().nonnegative().safe(),
    message: z
      .object({
        message_id: z.number().int().positive().safe(),
        from: z
          .object({
            id: z.number().int().positive().safe(),
            is_bot: z.literal(false),
          })
          .passthrough(),
        chat: z
          .object({
            id: z.number().int().positive().safe(),
            type: z.literal("private"),
          })
          .passthrough(),
        text: z.string().max(4096),
      })
      .passthrough(),
  })
  .passthrough();
export type Event = z.infer<typeof eventSchema>;
export function parseAction(text: string) {
  const m =
    /^(?:iva_panels|ipanel):([a-f0-9]{24}):(0|[1-9]\d{0,8}):(0|[1-9]\d?)$/.exec(
      text,
    );
  return m
    ? { screen: m[1], revision: Number(m[2]), index: Number(m[3]) }
    : null;
}
export function owns(text: unknown): boolean {
  return (
    typeof text === "string" &&
    (text === "/panels" ||
      text.startsWith(PREFIX) ||
      text.startsWith(LEGACY_PREFIX))
  );
}
export function escape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
export function render(view: View, screen: string, revision: number) {
  const valid = viewSchema.parse(view);
  const text = `<b>${escape(valid.title)}</b>\n\n${escape(valid.body)}`;
  if (text.length > LIMITS.page) throw new Error("PAGE_TOO_LARGE");
  let index = 0;
  return {
    text,
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: valid.rows.map((row) =>
        row.map((button) => ({
          text: button.label,
          callback_data: `${PREFIX}${screen}:${revision}:${index++}`,
          style:
            button.id === "close" ||
            button.id.startsWith("bitrix:cancel:") ||
            button.id.startsWith("life:cancel:")
              ? ("danger" as const)
              : button.id.startsWith("bitrix:confirm:") ||
                  button.id.startsWith("life:confirm:")
                ? ("success" as const)
                : undefined,
        })),
      ),
    },
  };
}
export const configSchema = z
  .object({
    upstream: z.string().url(),
    secret: z.string().min(16),
    botToken: z.string().regex(/^\d+:[A-Za-z0-9_-]+$/),
    owners: z.array(z.number().int().positive().safe()).min(1),
    mode: z.enum(["passthrough", "panels"]).default("passthrough"),
    bitrixReadOnly: z.boolean().default(false),
    presentation: z.enum(["classic", "rich"]).default("classic"),
    bitrixSettings: z.boolean().default(false),
    lifecycle: z
      .object({
        cli: z
          .string()
          .min(1)
          .max(512)
          .regex(/^\/[^\0]*\/iva\.mjs$/),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.bitrixSettings && !c.bitrixReadOnly)
      ctx.addIssue({
        code: "custom",
        message: "bitrixSettings requires bitrixReadOnly",
      });
    const u = new URL(c.upstream);
    if (
      u.protocol !== "http:" ||
      u.hostname !== "127.0.0.1" ||
      u.pathname !== "/" ||
      u.username ||
      u.password ||
      u.search ||
      u.hash
    )
      ctx.addIssue({
        code: "custom",
        message: "upstream must be a credential-free loopback HTTP origin",
      });
  });
export type Config = z.infer<typeof configSchema>;
