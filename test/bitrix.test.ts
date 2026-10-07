import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bitrixReader,
  bitrixPage,
} from "../plugin/sh.iva/services/router/bitrix.ts";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
import { viewSchema } from "../plugin/sh.iva/services/router/contracts.ts";
const value = {
  state: "screen",
  settings: {
    schema: 1,
    revision: 0,
    policy: {
      mode: "read_only",
      uploads: true,
      deletions: false,
      people: "names",
      email: false,
    },
  },
  markdown: "secret should never be shown",
};
test("Bitrix settings sections show effective plugin policy without mutation actions or untrusted text", async () => {
  for (const section of ["home", "actions", "privacy"]) {
    const view = viewSchema.parse(await bitrixPage(section, async () => value));
    assert(!JSON.stringify(view).includes("secret"));
    assert(view.body.includes("Исходные настройки"));
    assert(!JSON.stringify(view.rows).includes("b24s:"));
    assert(view.rows.flat().some((b) => b.id === "close"));
  }
  const action = await bitrixPage("actions", async () => value);
  assert(action.body.includes("только в режиме записи"));
  const privacy = await bitrixPage("privacy", async () => value);
  assert(privacy.body.includes("ID и имена"));
  await assert.rejects(bitrixPage("confirm", async () => value));
});
test("diagnostics project only allowlisted fields; errors remain navigable", async () => {
  const connection = await bitrixPage("connection", async () => ({
    connected: true,
    taskScope: true,
    taskContentChecked: false,
    contractVersion: "0.4",
    user: { name: "private person" },
  }));
  assert(connection.body.includes("Соединение работает"));
  assert(!connection.body.includes("private person"));
  const capabilities = await bitrixPage("capabilities", async () => ({
    contractVersion: "0.4",
    grantedScopes: ["task", "disk", "untrusted value"],
  }));
  assert(capabilities.body.includes("Вложения задач: право есть"));
  assert(!capabilities.body.includes("untrusted"));
  for (const result of [
    null,
    {
      ...value,
      settings: {
        ...value.settings,
        policy: { ...value.settings.policy, email: true },
      },
    },
  ]) {
    const error = await bitrixPage("actions", async () => result);
    assert(error.body.includes("Не удалось"));
    assert(error.rows.flat().some((b) => b.id === "bitrix24-read"));
  }
  assert(
    !(
      await bitrixPage("connection", async () => {
        throw new Error("private credential");
      })
    ).body.includes("credential"),
  );
});
test("explicit opt-in and enabled/trusted registry guard apply to every Bitrix subpage", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "panels-bitrix-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(join(data, "custom"));
  const path = join(data, "custom/plugins.json");
  const plugin = { name: "bitrix24-read", trusted: true, enabled: true };
  await writeFile(path, JSON.stringify({ plugins: [plugin] }));
  let calls = 0;
  const read = async () => {
    calls++;
    return value;
  };
  await installedPanels(data, false, read).page("bitrix24-read");
  assert(
    (
      await installedPanels(data, false, read).page("bitrix:actions")
    ).body.includes("выключен"),
  );
  assert.equal(calls, 0);
  await installedPanels(data, true, read).page("bitrix:actions");
  assert.equal(calls, 1);
  for (const disabled of [
    { ...plugin, enabled: false },
    { ...plugin, trusted: false },
  ]) {
    await writeFile(path, JSON.stringify({ plugins: [disabled] }));
    assert(
      (
        await installedPanels(data, true, read).page("bitrix:actions")
      ).body.includes("Собственные разделы доступны"),
    );
  }
  assert.equal(calls, 1);
});
test("isolated MCP reader sends only static read calls and scoped environment; closes child", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "panels-stdio-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const root = join(data, "custom/plugins/bitrix24-read");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "plugin.json"),
    JSON.stringify({ name: "bitrix24-read", version: "0.9.0-rc.1" }),
  );
  await writeFile(
    join(data, "custom/plugins/bitrix24-read.env"),
    "BITRIX24_SETTINGS_DEFAULTS=restricted\nUNRELATED_SECRET=must-not-inherit\n",
    { mode: 0o600 },
  );
  // A real child process implementing just the stdio protocol, without remote calls.
  await writeFile(
    join(root, "server.mjs"),
    `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const log = ${JSON.stringify(join(data, "calls.jsonl"))};
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 appendFileSync(log,JSON.stringify({method:m.method,params:m.params,extra:process.env.UNRELATED_SECRET ?? null,bot:process.env.TELEGRAM_BOT_TOKEN ?? null})+'\\n');
 const result=m.method==='initialize' ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}} : {content:[{type:'text',text:JSON.stringify(${JSON.stringify(value)})}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});
`,
  );
  const before = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "synthetic-must-not-inherit";
  try {
    const read = bitrixReader(data);
    for (const page of [
      "home",
      "connection",
      "capabilities",
      "actions",
      "privacy",
    ] as const)
      await read(page);
  } finally {
    if (before === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = before;
  }
  const calls = (await readFile(join(data, "calls.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((s) => JSON.parse(s));
  assert.equal(calls.filter((c) => c.method === "initialize").length, 5);
  const tools = calls.filter((c) => c.method === "tools/call");
  assert.deepEqual(
    tools.map((c) => c.params),
    [
      { name: "bitrix24_settings", arguments: { screen: "actions" } },
      { name: "bitrix24_connection_check", arguments: {} },
      { name: "bitrix24_capabilities", arguments: {} },
      { name: "bitrix24_settings", arguments: { screen: "actions" } },
      { name: "bitrix24_settings", arguments: { screen: "privacy" } },
    ],
  );
  assert(calls.every((c) => c.extra === null && c.bot === null));
});
