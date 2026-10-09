// Optional helper for plugin-owned local settings. No dependency on Panels at runtime.
import { constants } from "node:fs";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import {
  mkdir,
  open,
  rename,
  lstat,
  unlink,
  chmod,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const slug = /^[a-z][a-z0-9-]{0,23}$/;
const token = /^[a-f0-9]{24}$/;
const rev = (v) => Number.isSafeInteger(v) && v >= 0 && v <= 999999999999;
function keys(value, expected) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== expected.sort().join(",")
  )
    throw new Error("INVALID_REQUEST");
}
async function jsonFile(path) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.mode & 0o077 || info.size > 65536)
      throw new Error("PRIVATE_STATE_REQUIRED");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
async function save(directory, state) {
  const serialized = JSON.stringify(state);
  if (Buffer.byteLength(serialized) > 65536) throw new Error("STATE_TOO_LARGE");
  const path = join(
    directory,
    `.panel-state-${randomBytes(8).toString("hex")}.tmp`,
  );
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(serialized);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(path, join(directory, "panels-settings.json"));
  const dir = await open(directory, "r");
  try {
    await dir.sync();
  } finally {
    await dir.close();
  }
}
// The plugin supplies validation and presentation; only a local config patch is supported.
// External business effects need a plugin-owned durable operation protocol instead.
export async function serveSettings({
  name,
  version,
  directory,
  defaults,
  validate,
  screen,
  propose,
}) {
  if (
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name) ||
    name.includes("..") ||
    name.includes("--")
  )
    throw new Error("INVALID_NAME");
  directory = resolve(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await realpath(directory)) !== directory)
    throw new Error("REAL_DIRECTORY_REQUIRED");
  const socket = join(directory, "panels.sock");
  try {
    const info = await lstat(socket);
    if (!info.isSocket()) throw new Error("SOCKET_REQUIRED");
    const active = await new Promise((resolve, reject) => {
      const client = createConnection(socket);
      client.setTimeout(1000, () => {
        client.destroy();
        reject(new Error("SOCKET_BUSY"));
      });
      client.on("connect", () => {
        client.destroy();
        resolve(true);
      });
      client.on("error", (error) => {
        if (error.code === "ECONNREFUSED") resolve(false);
        else reject(error);
      });
    });
    if (active) throw new Error("ALREADY_RUNNING");
    await unlink(socket);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let state;
  try {
    state = await jsonFile(join(directory, "panels-settings.json"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = {
      schema: 1,
      revision: 0,
      settings: validate(defaults),
      offer: null,
      last: null,
    };
    await save(directory, state);
  }
  keys(state, ["schema", "revision", "settings", "offer", "last"]);
  if (state.schema !== 1 || !rev(state.revision))
    throw new Error("INVALID_STATE");
  state.settings = validate(state.settings);
  if (state.offer) {
    keys(state.offer, [
      "token",
      "revision",
      "expiresAt",
      "summary",
      "settings",
    ]);
    if (
      !token.test(state.offer.token) ||
      !rev(state.offer.revision) ||
      !Number.isSafeInteger(state.offer.expiresAt) ||
      typeof state.offer.summary !== "string" ||
      state.offer.summary.length > 1500
    )
      throw new Error("INVALID_STATE");
    state.offer.settings = validate(state.offer.settings);
  }
  if (state.last) {
    keys(state.last, ["state", "token", "revision", "message"]);
    if (
      !token.test(state.last.token) ||
      !rev(state.last.revision) ||
      !["done", "cancelled"].includes(state.last.state) ||
      typeof state.last.message !== "string"
    )
      throw new Error("INVALID_STATE");
  }
  let tail = Promise.resolve();
  let poisoned = false;
  async function persist() {
    try {
      await save(directory, state);
    } catch (error) {
      poisoned = true;
      throw error;
    }
  }
  async function handle(body) {
    if (poisoned) throw new Error("STATE_RECONCILIATION_REQUIRED");
    const fields = {
      read: ["page"],
      prepare: ["action", "revision", "token"],
      confirm: ["token"],
      cancel: ["token"],
      status: ["token"],
    };
    if (!fields[body.op]) throw new Error("INVALID_OP");
    keys(body, ["schema", "plugin", "pluginVersion", "op", ...fields[body.op]]);
    if (
      body.schema !== "iva-panels/rpc-v1" ||
      body.plugin !== name ||
      body.pluginVersion !== version
    )
      throw new Error("IDENTITY_MISMATCH");
    if (body.op === "read") {
      if (!slug.test(body.page)) throw new Error("INVALID_PAGE");
      return {
        state: "screen",
        revision: state.revision,
        ...(await screen(body.page, structuredClone(state.settings))),
      };
    }
    if (!token.test(body.token)) throw new Error("INVALID_TOKEN");
    if (body.op === "prepare") {
      if (!slug.test(body.action) || !rev(body.revision))
        throw new Error("INVALID_REQUEST");
      const rejected = (message) => ({
        state: "rejected",
        token: body.token,
        message,
      });
      if (body.revision !== state.revision)
        return rejected(
          "Настройки изменились. Обновите сведения и сделайте выбор заново.",
        );
      if (state.offer && state.offer.expiresAt > Date.now())
        return rejected(
          "У плагина уже есть активное предложение. Завершите его в исходном интерфейсе.",
        );
      let change;
      try {
        change = await propose(body.action, structuredClone(state.settings));
      } catch {
        return rejected("Плагин отклонил выбор. Обновите настройки.");
      }
      if (
        typeof change.summary !== "string" ||
        !change.summary.length ||
        change.summary.length > 1500
      )
        throw new Error("INVALID_SUMMARY");
      state.offer = {
        token: body.token,
        revision: state.revision,
        expiresAt: Date.now() + 5 * 60000,
        summary: change.summary,
        settings: validate(change.settings),
      };
      await persist();
      const { settings: _settings, ...offer } = state.offer;
      return { state: "offer", ...offer };
    }
    if (state.last?.token === body.token) return state.last;
    if (state.offer?.token !== body.token) throw new Error("OFFER_UNKNOWN");
    if (body.op === "status") {
      const { settings: _settings, ...offer } = state.offer;
      return { state: "offer", ...offer };
    }
    if (body.op === "confirm") {
      if (
        state.offer.expiresAt <= Date.now() ||
        state.offer.revision !== state.revision ||
        state.revision === 999999999999
      )
        throw new Error("OFFER_EXPIRED");
      // Config, revision and terminal receipt are committed together, before response.
      state.settings = validate(state.offer.settings);
      state.revision++;
    }
    state.last = {
      state: body.op === "confirm" ? "done" : "cancelled",
      token: body.token,
      revision: state.revision,
      message:
        body.op === "confirm" ? "Настройки сохранены." : "Изменение отменено.",
    };
    state.offer = null;
    await persist();
    return state.last;
  }
  const server = createServer(async (req, res) => {
    const respond = (code, value) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (req.method !== "POST" || req.url !== "/panels/v1") {
      respond(404, { error: "NOT_FOUND" });
      return;
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 32768) throw new Error("TOO_LARGE");
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const operation = tail.then(() => handle(body));
      // Failed persistence requires restart and disk reconciliation, not an in-memory retry.
      tail = operation.catch(() => {});
      const result = await operation;
      respond(200, {
        schema: "iva-panels/rpc-v1",
        plugin: name,
        pluginVersion: version,
        result,
      });
    } catch {
      respond(409, { error: "PANEL_REQUEST_REJECTED" });
    }
  });
  server.requestTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socket, resolve);
  });
  await chmod(socket, 0o600);
  return server;
}
