import { createServer } from "node:http";
import { lstat, chmod, unlink, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Engine } from "./engine.ts";
import { pluginKey, pluginName } from "./catalog.ts";
const inputSchema = z
  .object({
    schema: z.literal("iva-panels/chat-v1"),
    plugin: pluginName,
    action: z.string().regex(/^[a-z][a-z0-9-]{0,23}$/),
    revision: z.number().int().nonnegative().max(999999999999),
    requestId: z.string().regex(/^[a-f0-9]{24}$/),
  })
  .strict();
/** Local trusted plugin transport. No arbitrary recipients, callback IDs or confirm operation. */
export async function serveChatCards(
  directory: string,
  engine: Pick<Engine, "issue">,
  owners: readonly number[],
) {
  if ((await realpath(directory)) !== directory)
    throw new Error("PRIVATE_DIRECTORY_REQUIRED");
  const path = join(directory, "chat.sock");
  try {
    const st = await lstat(path);
    if (!st.isSocket() || st.uid !== process.getuid?.())
      throw new Error("INVALID_SOCKET");
    await unlink(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/cards/v1")
        throw new Error("BAD_REQUEST");
      if (owners.length !== 1) throw new Error("OWNER_CONTEXT_REQUIRED");
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) throw new Error("TOO_LARGE");
        chunks.push(Buffer.from(chunk));
      }
      const v = inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString()));
      const id = createHash("sha256")
        .update(JSON.stringify([v.plugin, v.action, v.revision, v.requestId]))
        .digest("hex")
        .slice(0, 24);
      const result = await engine.issue(
        id,
        `dyn:prepare:${pluginKey(v.plugin)}:${v.revision}:${v.action}`,
        owners[0],
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ schema: "iva-panels/chat-v1", ...result }));
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "CHAT_CARD_UNAVAILABLE" }));
    }
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  await chmod(path, 0o600);
  return server;
}
