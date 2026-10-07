// Real installed Bitrix bundle; synthetic private data and no webhook/network credentials.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  bitrixReader,
  bitrixChanger,
  bitrixPage,
  bitrixChangePage,
} from "../plugin/sh.iva/services/router/bitrix.ts";
import { viewSchema } from "../plugin/sh.iva/services/router/contracts.ts";
const plugin = process.argv[2];
if (!plugin) throw new Error("Pass exact Bitrix24 plugin folder");
const data = await mkdtemp(join(tmpdir(), "panels-settings-"));
try {
  const root = join(data, "custom/plugins/bitrix24-read");
  const storage = join(data, "plugin-data/bitrix24-read");
  await mkdir(root, { recursive: true });
  await mkdir(storage, { recursive: true, mode: 0o700 });
  await copyFile(join(resolve(plugin), "server.mjs"), join(root, "server.mjs"));
  await copyFile(
    join(resolve(plugin), "plugin.json"),
    join(root, "plugin.json"),
  );
  const read = bitrixReader(data),
    change = bitrixChanger(data);
  const policy = async () =>
    JSON.parse(await readFile(join(storage, "settings.json"), "utf8"));
  const select = async (revision: number, choice: string) =>
    viewSchema.parse(
      await bitrixChangePage(`bitrix:set:${revision}:${choice}`, change, read),
    );
  const button = (view: Awaited<ReturnType<typeof select>>, type: string) =>
    view.rows.flat().find((b) => b.id.startsWith(`bitrix:${type}:`))!.id;
  const initial = viewSchema.parse(await bitrixPage("privacy", read, true));
  assert(initial.rows.flat().some((b) => b.id === "bitrix:set:0:work"));
  const preview = await select(0, "work");
  assert(
    preview.body.includes("Сейчас:") &&
      preview.body.includes("После подтверждения:"),
  );
  await assert.rejects(policy(), { code: "ENOENT" }); // selection never commits policy
  const saved = await bitrixChangePage(
    button(preview, "confirm"),
    change,
    read,
  );
  assert(saved.body.includes("Настройки сохранены"));
  assert.equal((await policy()).revision, 1);
  assert.equal((await policy()).policy.people, "work");
  const replay = await bitrixChangePage(
    button(preview, "confirm"),
    change,
    read,
  );
  assert(replay.body.includes("устарело"));
  assert.equal((await policy()).revision, 1);
  const cancelled = await select(1, "email_on");
  await bitrixChangePage(button(cancelled, "cancel"), change, read);
  assert.equal((await policy()).policy.email, false);
  assert.equal((await policy()).revision, 1);
  const email = await select(1, "email_on");
  await bitrixChangePage(button(email, "confirm"), change, read);
  assert.equal((await policy()).policy.email, true);
  const old = await select(2, "ids");
  const current = await select(2, "names");
  assert(
    (
      await bitrixChangePage(button(old, "confirm"), change, read)
    ).body.includes("устарело"),
  );
  await bitrixChangePage(button(current, "cancel"), change, read);
  assert.equal((await policy()).policy.people, "work");
  const expired = await select(2, "write");
  const offerPath = join(storage, "settings-offer.json");
  const offer = JSON.parse(await readFile(offerPath, "utf8"));
  offer.createdAt = Date.now() - 11 * 60_000;
  await writeFile(offerPath, JSON.stringify(offer), { mode: 0o600 });
  assert(
    (
      await bitrixChangePage(button(expired, "confirm"), change, read)
    ).body.includes("устарело"),
  );
  assert.equal((await policy()).revision, 2);
  const conflict = await select(2, "ids");
  const concurrent = await policy();
  concurrent.revision++;
  await writeFile(join(storage, "settings.json"), JSON.stringify(concurrent), {
    mode: 0o600,
  });
  assert(
    (
      await bitrixChangePage(button(conflict, "confirm"), change, read)
    ).body.includes("устарело"),
  );
  assert.equal((await policy()).policy.people, "work");
  const names = await select(3, "names");
  await bitrixChangePage(button(names, "confirm"), change, read);
  assert.equal((await policy()).policy.email, false); // plugin enforces dependent field
  console.log(
    "Real Bitrix settings passed: preview/cancel/confirm/replay/expiry/revision conflict/people-email policy",
  );
} finally {
  await rm(data, { recursive: true, force: true });
}
