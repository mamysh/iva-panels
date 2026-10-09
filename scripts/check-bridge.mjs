// Optional integration check against an independently installed stock Iva checkout.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  realpath,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
const core = process.argv[2];
if (!core) throw new Error("Pass an isolated stock Iva checkout");
const directory = await realpath(await mkdtemp("/tmp/pb-"));
const servers = [];
const network = globalThis.fetch;
const calls = [];
const upstreamCalls = [];
let nextMessage = 1000;
let failNextEdit = false;
let child;
let exited;
let bitrixService;
let bitrixExited;
async function stopService() {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exited;
  }
}
async function listen(server) {
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
try {
  await mkdir(join(directory, "custom"));
  await writeFile(
    join(directory, "custom/plugins.json"),
    JSON.stringify({
      plugins: [
        {
          name: "bitrix24-read",
          enabled: true,
          trusted: true,
          sha: "synthetic",
        },
        { name: "demo", enabled: true, trusted: true },
        { name: "offline", enabled: false, trusted: false },
        {
          name: "file-delivery",
          enabled: true,
          trusted: true,
          sha: "a".repeat(40),
        },
      ],
    }),
  );
  await mkdir(join(directory, "custom/plugins/file-delivery"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "custom/plugins/file-delivery/plugin.json"),
    JSON.stringify({ name: "file-delivery", version: "0.3.2" }),
  );
  await mkdir(join(directory, "custom/plugins/demo"), { recursive: true });
  await writeFile(
    join(directory, "custom/plugins/demo/plugin.json"),
    JSON.stringify({ name: "demo", version: "1.0.0" }),
  );
  await writeFile(
    join(directory, "custom/plugins/demo/panels.json"),
    JSON.stringify({
      schema: "iva-panels/v1",
      plugin: "demo",
      pluginVersion: "1.0.0",
      entry: "home",
      pages: [
        {
          id: "home",
          title: "Synthetic demo",
          body: "Contract page",
          rows: [[{ label: "Details", target: "details" }]],
        },
        {
          id: "details",
          title: "Synthetic details",
          body: "Contract details",
          rows: [[{ label: "Demo home", target: "home" }]],
        },
      ],
    }),
  );
  const upstream = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const part of req) body += part;
      upstreamCalls.push({ path: req.url, body });
      res.writeHead(204, { "x-iva-telegram-acceptance": "handled" });
      res.end();
    }),
  );
  const botOrigin = await listen(
    createServer(async (req, res) => {
      let body = "";
      for await (const bytes of req) body += bytes;
      const method = req.url.slice(1);
      assert.notEqual(method, "getUpdates");
      calls.push({ method, body: JSON.parse(body) });
      if (method === "editMessageText" && failNextEdit) {
        failNextEdit = false;
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ ok: false, description: "synthetic failure" }),
        );
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          ok: true,
          result: ["sendMessage", "sendRichMessage"].includes(method)
            ? { message_id: nextMessage++ }
            : true,
        }),
      );
    }),
  );
  const reserve = createServer();
  await new Promise((r) => reserve.listen(0, "127.0.0.1", r));
  const port = reserve.address().port;
  await new Promise((r) => reserve.close(r));
  const router = `http://127.0.0.1:${port}`;
  const panels = join(directory, "panels");
  await mkdir(panels, { mode: 0o700 });
  await writeFile(
    join(panels, "config.json"),
    JSON.stringify({
      upstream,
      secret: "synthetic-secret-123",
      botToken: "424242:synthetic",
      owners: [42],
      mode: "panels",
    }),
    { mode: 0o600 },
  );
  const preload = join(directory, "synthetic-telegram.mjs");
  await writeFile(
    preload,
    `const network=globalThis.fetch;globalThis.fetch=(url,init)=>{const u=new URL(String(url));if(u.hostname==='api.telegram.org')return network(process.env.SYNTHETIC_BOT_ORIGIN+'/'+u.pathname.split('/').at(-1),init);if(u.hostname==='api.github.com'&&u.pathname==='/repos/mamysh/iva-file-delivery/commits/stable')return Promise.resolve(new Response(JSON.stringify({sha:'b'.repeat(40)})));if(u.hostname==='raw.githubusercontent.com'&&u.pathname==='/mamysh/iva-file-delivery/'+ 'b'.repeat(40)+'/plugin/plugin.json')return Promise.resolve(new Response(JSON.stringify({name:'file-delivery',version:'0.3.3'})));if(u.hostname==='api.github.com'&&u.pathname==='/repos/mamysh/iva-file-delivery/actions/runs')return Promise.resolve(new Response(JSON.stringify({workflow_runs:[{head_sha:'b'.repeat(40),path:'.github/workflows/ci.yml',event:'push',status:'completed',conclusion:'success',run_number:1,run_attempt:1}]})));if(u.hostname!=='127.0.0.1')throw new Error('Unexpected external request');return network(url,init);};`,
  );
  async function startService() {
    child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(preload).href,
        resolve("plugin/sh.iva/services/router/server.mjs"),
      ],
      {
        env: {
          ...process.env,
          PLUGIN_DATA: panels,
          IVA_DATA_DIR: directory,
          IVA_SERVICE_PORT: String(port),
          SYNTHETIC_BOT_ORIGIN: botOrigin,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    exited = once(child, "exit");
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await network(router + "/health");
        assert.equal(response.status, 200);
        break;
      } catch (error) {
        if (attempt >= 100 || child.exitCode !== null) throw error;
        await new Promise((r) => setTimeout(r, 25));
      }
    }
  }
  await startService();
  Object.assign(process.env, {
    ASSISTANT_DATA_DIR: directory,
    ASSISTANT_VAULT_DIR: join(directory, "vault"),
    ASSISTANT_HOST: router,
    TELEGRAM_BOT_TOKEN: "424242:synthetic",
    TELEGRAM_WEBHOOK_SECRET_TOKEN: "synthetic-secret-123",
    TELEGRAM_ALLOWED_USER_IDS: "42",
    TELEGRAM_POLL_SETTLE_MS: "0",
    TELEGRAM_COLLECT_QUIET_MS: "0",
    AGENT_LANGUAGE: "en",
  });
  globalThis.fetch = async (url, init) => {
    const address = new URL(String(url));
    if (address.hostname === "api.telegram.org") {
      const method = address.pathname.split("/").at(-1);
      assert.notEqual(method, "getUpdates");
      const body = JSON.parse(String(init?.body));
      calls.push({ method, body });
      return Response.json({
        ok: true,
        result: method === "sendMessage" ? { message_id: nextMessage++ } : true,
      });
    }
    assert.equal(address.hostname, "127.0.0.1");
    return network(url, init);
  };
  const load = (relative) =>
    import(pathToFileURL(resolve(core, relative)).href);
  const units = await load("scripts/lib/plugin-units.ts");
  const body = units.pluginServiceUnitBody({
    plugin: "iva-panels",
    service: "router",
    pluginRoot: resolve("plugin"),
    pluginData: panels,
    port,
    command: "bash",
    args: ["launch.sh"],
    nodeBinDir: resolve(process.execPath, ".."),
    dataDir: directory,
  });
  assert(
    body.includes(
      "WorkingDirectory=" + resolve("plugin/sh.iva/services/router"),
    ),
  );
  assert(body.includes("IVA_SERVICE_PORT"));
  assert(body.includes("PLUGIN_DATA"));
  assert(body.includes("launch.sh"));
  assert(!body.includes("synthetic-secret"));
  const main = await load("scripts/poller/main.ts");
  const inbox = await load("scripts/poller/inbox.ts");
  const status = await load("agent/lib/run-status.ts");
  const queue = await load("scripts/poller/queue.ts");
  let updateId = 10;
  const message = (text) => ({
    update_id: updateId++,
    message: {
      message_id: updateId + 100,
      date: 1,
      from: { id: 42, is_bot: false, first_name: "Synthetic" },
      chat: { id: 42, type: "private" },
      text,
    },
  });
  const tap = (data, messageId = 1000) => ({
    update_id: updateId++,
    callback_query: {
      id: `synthetic-${updateId}`,
      from: { id: 42, is_bot: false, first_name: "Synthetic" },
      data,
      message: {
        message_id: messageId,
        date: 1,
        text: "Synthetic panel text must not be appended to callback data",
        from: { id: 424242, is_bot: true },
        chat: { id: 42, type: "private" },
      },
    },
  });
  async function accept(update) {
    const result = await main.processTelegramUpdate(update, 0, null);
    assert.equal(result.ingressBlocked, false);
    return update;
  }
  async function promote(options = {}) {
    await inbox.promoteReadyInbox({
      collectorOptions: { quietMs: 0 },
      ...options,
    });
  }
  await accept(message("/panels"));
  await promote();
  const opens = () =>
    calls.filter(
      (c) => c.method === "sendMessage" && c.body.text.startsWith("<b>Плагины"),
    );
  assert.equal(opens().length, 1);
  assert.equal(upstreamCalls.length, 0);
  const callback =
    opens()[0].body.reply_markup.inline_keyboard[0][0].callback_data;
  const click = tap(callback);
  await accept(click);
  await promote();
  assert.equal(click.callback_query.message.message_id, 1000);
  assert.equal(click.callback_query.from.id, 42);
  assert.equal(click.message, undefined);
  assert(
    calls.some(
      (c) =>
        c.method === "editMessageText" &&
        c.body.message_id === 1000 &&
        c.body.text.startsWith("<b>Bitrix24"),
    ),
  );
  await stopService();
  await startService();
  await accept(structuredClone(click));
  await promote();
  assert.equal(opens().length, 1);
  assert.equal(
    calls.filter(
      (c) => c.method === "editMessageText" && c.body.message_id === 1000,
    ).length,
    1,
  );
  const back = calls
    .filter((c) => c.method === "editMessageText")
    .at(-1)
    .body.reply_markup.inline_keyboard.flat()
    .find((b) => b.text === "К плагинам").callback_data;
  status.setChatStatus("42:", {
    status: "running",
    sessionId: "synthetic",
    turnId: "synthetic",
  });
  await accept(tap(back));
  await promote();
  // Reserved callbacks are delivered independently of a running model turn.
  assert.equal((await queue.loadQueue()).queues["42:"]?.length ?? 0, 0);
  assert.equal(
    calls.filter(
      (c) => c.method === "editMessageText" && c.body.message_id === 1000,
    ).length,
    2,
  );
  status.setChatStatus("42:", { status: "idle", sessionId: "synthetic" });
  await main.drainReadyQueueHeads();
  assert.equal((await queue.loadQueue()).queues["42:"]?.length ?? 0, 0);
  assert.equal(queue.queueInFlight.size, 0);
  const newChoice = calls
    .filter((c) => c.method === "editMessageText" && c.body.message_id === 1000)
    .at(-1).body.reply_markup.inline_keyboard[0][0].callback_data;
  failNextEdit = true;
  const retryTap = tap(newChoice);
  await accept(retryTap);
  await promote();
  await stopService();
  await startService();
  // The same durable callback can retry delivery, not the action.
  await accept(structuredClone(retryTap));
  await promote();
  assert.equal((await queue.loadQueue()).queues["42:"]?.length ?? 0, 0);
  assert.equal(queue.queueInFlight.size, 0);
  assert.equal(opens().length, 1);

  await accept(message("ordinary synthetic message"));
  await promote();
  assert.equal(
    JSON.parse(upstreamCalls.at(-1).body).message.text,
    "ordinary synthetic message",
  );
  const native = {
    update_id: updateId++,
    callback_query: {
      id: "native",
      from: { id: 42, is_bot: false },
      data: "eve:synthetic",
      message: {
        message_id: 999,
        date: 1,
        chat: { id: 42, type: "private" },
        from: { id: 424242, is_bot: true },
      },
    },
  };
  await accept(native);
  await promote();
  assert.equal(
    JSON.parse(upstreamCalls.at(-1).body).callback_query.data,
    "eve:synthetic",
  );
  // Default collector must preserve ordinary text alongside a panel command.
  const before = upstreamCalls.length;
  await accept(message("/panels"));
  await accept(message("ordinary batched text"));
  await inbox.promoteReadyInbox({ now: () => Date.now() + 2000 });
  const forwarded = JSON.parse(upstreamCalls.at(-1).body);
  assert.equal(upstreamCalls.length, before + 1);
  assert.equal(forwarded.message.text, "ordinary batched text");
  assert.equal(forwarded.message.iva_parts, undefined);
  assert.match(forwarded.message.iva_durable_queue_receipt, /^[a-f0-9]{32}$/);
  await accept(message("ordinary first"));
  await accept(message("/panels"));
  await inbox.promoteReadyInbox({ now: () => Date.now() + 2000 });
  assert.equal(
    JSON.parse(upstreamCalls.at(-1).body).message.text,
    "ordinary first",
  );
  const commandsBefore = opens().length;
  await accept(message("/panels"));
  await accept(message("/panels"));
  await inbox.promoteReadyInbox({ now: () => Date.now() + 2000 });
  assert.equal(opens().length, commandsBefore + 2);
  const close = calls
    .filter((c) => c.method === "editMessageText" && c.body.message_id === 1000)
    .at(-1)
    .body.reply_markup.inline_keyboard.at(-1)
    .at(-1).callback_data;
  await accept(tap(close));
  await promote();
  assert(
    calls.some(
      (c) =>
        c.method === "editMessageText" &&
        c.body.message_id === 1000 &&
        c.body.text.includes("Панель закрыта"),
    ),
  );
  for (const path of ["/eve/v1/telegram/reset", "/eve/v1/telegram/cancel"]) {
    await network(router + path, { method: "POST", body: "{}" });
    assert.equal(upstreamCalls.at(-1).path, path);
  }

  // Exercise the bundled adapter through the same stock Bridge, using an isolated
  // synthetic MCP child. No shared MCP proxy or remote Bitrix call is involved.
  await stopService();
  const bitrixRoot = join(directory, "custom/plugins/bitrix24-read");
  await mkdir(bitrixRoot, { recursive: true });
  await writeFile(
    join(bitrixRoot, "plugin.json"),
    JSON.stringify({ name: "bitrix24-read", version: "0.9.0-rc.1" }),
  );
  await writeFile(
    join(bitrixRoot, "server.mjs"),
    `
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 if(m.method==='tools/call' && (m.params.name!=='bitrix24_settings' || m.params.arguments.reply)) throw new Error('Unexpected mutation');
 const result=m.method==='initialize' ? {protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'synthetic',version:'1'}} : {content:[{type:'text',text:JSON.stringify({state:'screen',settings:{schema:1,revision:7,policy:{mode:'read_only',uploads:false,deletions:false,people:'ids',email:false}}})}]};
 console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});`,
  );
  const config = JSON.parse(
    await readFile(join(panels, "config.json"), "utf8"),
  );
  config.bitrixReadOnly = true;
  await writeFile(join(panels, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  await startService();
  const adapterMessage = nextMessage;
  await accept(message("/panels"));
  await promote();
  const sendsBeforeAdapter = opens().length;
  let current = opens().at(-1).body;
  const choose = async (label) => {
    const button = current.reply_markup.inline_keyboard
      .flat()
      .find((b) => b.text === label);
    assert(button, label);
    await accept(tap(button.callback_data, adapterMessage));
    await promote();
    current = calls
      .filter(
        (c) =>
          c.method === "editMessageText" &&
          c.body.message_id === adapterMessage,
      )
      .at(-1).body;
  };
  await choose("Bitrix24");
  await choose("Совместимая панель");
  assert(current.text.includes("Ревизия настроек: 7"));
  await choose("Действия");
  assert(current.text.includes("только чтение"));
  await choose("Настройки Bitrix24");
  await choose("Данные");
  assert(current.text.includes("только ID"));
  await choose("Настройки Bitrix24");
  await choose("К плагинам");
  await choose("Закрыть");
  assert(current.text.includes("Панель закрыта"));
  assert.equal(opens().length, sendsBeforeAdapter);

  await stopService();
  config.presentation = "rich";
  config.lifecycle = { cli: join(directory, "iva.mjs") };
  await writeFile(join(panels, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  await startService();
  const richMessage = nextMessage;
  await accept(message("/panels"));
  await promote();
  let rich = calls.filter((c) => c.method === "sendRichMessage").at(-1).body
    .rich_message.html;
  assert(rich.includes("<tg-button-row>"));
  const richButton = (label) => {
    const buttons = [
      ...rich.matchAll(
        /<tg-button\b[^>]*data="([^"]+)"[^>]*>([^<]+)<\/tg-button>/g,
      ),
    ];
    const found = buttons.find((m) => m[2] === label);
    assert(found, `Missing button ${label}: ${rich}`);
    return found[1];
  };
  for (const label of [
    "Bitrix24",
    "Совместимая панель",
    "Действия",
    "Настройки Bitrix24",
    "К плагинам",
    "Отправка файлов",
    "Совместимая панель",
    "Правила отправки",
    "Отправка файлов",
    "Обновления",
    "Проверить stable",
    "Отправка файлов",
    "Управление плагином",
    "Выключить плагин",
    "Отменить",
    "О плагине",
    "К плагинам",
    "offline · выключен",
    "К плагинам",
    "demo",
    "Открыть разделы",
    "Details",
    "Demo home",
    "О плагине",
    "К плагинам",
    "Закрыть",
  ]) {
    await accept(tap(richButton(label), richMessage));
    await promote();
    rich = calls
      .filter(
        (c) =>
          c.method === "editMessageText" && c.body.message_id === richMessage,
      )
      .at(-1).body.rich_message.html;
    if (label === "Отменить")
      assert(rich.includes("Команда менеджеру не отправлялась"));
    if (label === "Details") assert(rich.includes("Contract details"));
    if (label === "offline · выключен")
      assert(rich.includes("Состояние: выключен"));
    if (label === "Правила отправки") assert(rich.includes("50 МиБ"));
    if (label === "Проверить stable") {
      assert(rich.includes("CI stable: успешен"));
      assert(rich.includes("более новая версия"));
    }
  }
  assert(rich.includes("Панель закрыта"));
  assert.equal(calls.filter((c) => c.method === "sendRichMessage").length, 1);
  if (process.argv[3]) {
    await stopService();
    await copyFile(
      join(resolve(process.argv[3]), "server.mjs"),
      join(bitrixRoot, "server.mjs"),
    );
    await copyFile(
      join(resolve(process.argv[3]), "plugin.json"),
      join(bitrixRoot, "plugin.json"),
    );
    const bitrixData = join(directory, "plugin-data/bitrix24-read");
    await mkdir(bitrixData, { recursive: true, mode: 0o700 });
    config.bitrixSettings = true;
    await writeFile(join(panels, "config.json"), JSON.stringify(config), {
      mode: 0o600,
    });
    await startService();
    const settingsMessage = nextMessage;
    await accept(message("/panels"));
    await promote();
    rich = calls.filter((c) => c.method === "sendRichMessage").at(-1).body
      .rich_message.html;
    const settingsTap = async (label) => {
      const event = tap(richButton(label), settingsMessage);
      await accept(event);
      await promote();
      rich = calls
        .filter(
          (c) =>
            c.method === "editMessageText" &&
            c.body.message_id === settingsMessage,
        )
        .at(-1).body.rich_message.html;
      return event;
    };
    await settingsTap("Bitrix24");
    await settingsTap("Совместимая панель");
    await settingsTap("Данные");
    await settingsTap("Рабочий профиль");
    assert(rich.includes("После подтверждения:"));
    await assert.rejects(readFile(join(bitrixData, "settings.json")), {
      code: "ENOENT",
    });
    await settingsTap("Отменить");
    await assert.rejects(readFile(join(bitrixData, "settings.json")), {
      code: "ENOENT",
    });
    await settingsTap("Данные");
    await settingsTap("Рабочий профиль");
    const confirm = await settingsTap("Подтвердить");
    assert(rich.includes("Настройки сохранены"));
    const state = JSON.parse(
      await readFile(join(bitrixData, "settings.json"), "utf8"),
    );
    assert.equal(state.revision, 1);
    assert.equal(state.policy.people, "work");
    await accept(confirm);
    await promote();
    assert.equal(
      JSON.parse(await readFile(join(bitrixData, "settings.json"), "utf8"))
        .revision,
      1,
    );
    await settingsTap("Закрыть");
  }
  // Generic v2 through real stock Bridge -> bundled Router -> plugin-owned socket.
  await stopService();
  const { serveSettings } =
    await import("../plugin/skills/iva-panels-integration/resources/settings-service.mjs");
  const dynamicName = "dynamic-demo";
  const dynamicRoot = join(directory, "custom/plugins", dynamicName);
  const dynamicData = join(directory, "plugin-data", dynamicName);
  await mkdir(dynamicRoot, { recursive: true });
  await writeFile(
    join(dynamicRoot, "plugin.json"),
    JSON.stringify({ name: dynamicName, version: "1.0.0" }),
  );
  await writeFile(
    join(dynamicRoot, "panels.json"),
    JSON.stringify({
      schema: "iva-panels/v2",
      plugin: dynamicName,
      pluginVersion: "1.0.0",
      entry: "home",
      capabilities: ["settings"],
    }),
  );
  const registrations = JSON.parse(
    await readFile(join(directory, "custom/plugins.json"), "utf8"),
  );
  registrations.plugins.push({
    name: dynamicName,
    enabled: true,
    trusted: true,
    sha: "b".repeat(40),
  });
  await writeFile(
    join(directory, "custom/plugins.json"),
    JSON.stringify(registrations),
  );
  const pluginService = await serveSettings({
    name: dynamicName,
    version: "1.0.0",
    directory: dynamicData,
    defaults: { compact: false },
    validate: (v) => {
      assert.equal(typeof v.compact, "boolean");
      return { compact: v.compact };
    },
    screen: () => ({
      title: "Generic settings",
      body: "Synthetic setting",
      rows: [[{ label: "Toggle compact", action: "toggle" }]],
    }),
    propose: (_action, v) => ({
      summary: "Compact: false -> true",
      settings: { compact: !v.compact },
    }),
  });
  servers.push(pluginService);
  config.dynamicPanels = true;
  await writeFile(join(panels, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  await startService();
  const dynamicMessage = nextMessage;
  await accept(message("/panels"));
  await promote();
  rich = calls.filter((c) => c.method === "sendRichMessage").at(-1).body
    .rich_message.html;
  async function dynamicTap(label) {
    const event = tap(richButton(label), dynamicMessage);
    await accept(event);
    await promote();
    rich = calls
      .filter(
        (c) =>
          c.method === "editMessageText" &&
          c.body.message_id === dynamicMessage,
      )
      .at(-1).body.rich_message.html;
    return event;
  }
  const savedSettings = async () =>
    JSON.parse(
      await readFile(join(dynamicData, "panels-settings.json"), "utf8"),
    );
  await dynamicTap(dynamicName);
  assert(rich.includes("объявлен API"));
  await dynamicTap("Настройки");
  await dynamicTap("Toggle compact");
  assert.equal((await savedSettings()).revision, 0);
  await dynamicTap("Отменить");
  assert.equal((await savedSettings()).settings.compact, false);
  await dynamicTap("О плагине");
  await dynamicTap("Настройки");
  await dynamicTap("Toggle compact");
  const genericConfirm = await dynamicTap("Подтвердить");
  assert(rich.includes("Настройки сохранены"));
  assert.equal((await savedSettings()).revision, 1);
  await stopService();
  await startService();
  await accept(structuredClone(genericConfirm));
  await promote();
  assert.equal((await savedSettings()).revision, 1);
  await accept(message("ordinary after generic settings"));
  await promote();
  assert.equal(
    JSON.parse(upstreamCalls.at(-1).body).message.text,
    "ordinary after generic settings",
  );
  await dynamicTap("Закрыть");
  // Actual Bitrix v2 settings through the same stock Bridge and bundled Router.
  if (process.argv[3]) {
    let definition;
    try {
      definition = JSON.parse(
        await readFile(join(resolve(process.argv[3]), "panels.json"), "utf8"),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (definition) {
      await copyFile(
        join(resolve(process.argv[3]), "panels.json"),
        join(bitrixRoot, "panels.json"),
      );
      const bitrixData = join(directory, "plugin-data/bitrix24-read");
      const reserveBitrix = createServer();
      await new Promise((r) => reserveBitrix.listen(0, "127.0.0.1", r));
      const bitrixPort = reserveBitrix.address().port;
      await new Promise((r) => reserveBitrix.close(r));
      bitrixService = spawn(
        process.execPath,
        [join(resolve(process.argv[3]), "sh.iva/services/panels/server.mjs")],
        {
          env: {
            PATH: process.env.PATH,
            IVA_DATA_DIR: directory,
            PLUGIN_DATA: bitrixData,
            IVA_SERVICE_PORT: String(bitrixPort),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      bitrixService.stdout.resume();
      bitrixService.stderr.resume();
      bitrixExited = once(bitrixService, "exit");
      for (let attempt = 0; ; attempt++) {
        try {
          assert.equal(
            (await network(`http://127.0.0.1:${bitrixPort}/health`)).status,
            200,
          );
          break;
        } catch (error) {
          if (attempt >= 100 || bitrixService.exitCode !== null) throw error;
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      const bitrixPolicy = async () =>
        JSON.parse(await readFile(join(bitrixData, "settings.json"), "utf8"));
      const v2Message = nextMessage;
      await accept(message("/panels"));
      await promote();
      rich = calls.filter((c) => c.method === "sendRichMessage").at(-1).body
        .rich_message.html;
      const v2Tap = async (label) => {
        const event = tap(richButton(label), v2Message);
        await accept(event);
        await promote();
        rich = calls
          .filter(
            (c) =>
              c.method === "editMessageText" && c.body.message_id === v2Message,
          )
          .at(-1).body.rich_message.html;
        return event;
      };
      await v2Tap("Bitrix24");
      await v2Tap("Настройки");
      await v2Tap("Данные сотрудников");
      await v2Tap("Разрешить email");
      assert(rich.includes("После подтверждения:"));
      assert.equal((await bitrixPolicy()).revision, 1);
      assert.equal((await bitrixPolicy()).policy.email, false);
      await v2Tap("Отменить");
      assert.equal((await bitrixPolicy()).revision, 1);
      await v2Tap("О плагине");
      await v2Tap("Настройки");
      await v2Tap("Данные сотрудников");
      await v2Tap("Разрешить email");
      const bitrixConfirm = await v2Tap("Подтвердить");
      assert(rich.includes("Настройки сохранены"));
      assert.equal((await bitrixPolicy()).revision, 2);
      assert.equal((await bitrixPolicy()).policy.email, true);
      await stopService();
      await startService();
      await accept(structuredClone(bitrixConfirm));
      await promote();
      assert.equal((await bitrixPolicy()).revision, 2);
      await v2Tap("О плагине");
      await v2Tap("Совместимая панель");
      await v2Tap("Данные");
      assert(rich.includes("разрешён"));
      await v2Tap("Закрыть");
      await accept(message("ordinary after Bitrix v2"));
      await promote();
      assert.equal(
        JSON.parse(upstreamCalls.at(-1).body).message.text,
        "ordinary after Bitrix v2",
      );
      console.log(
        "Bitrix v2 Bridge integration passed: cancel/confirm/duplicate/router restart/shared legacy policy",
      );
    }
  }
  console.log(
    "Bridge integration passed",
    execFileSync("git", ["-C", core, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
  );
} finally {
  globalThis.fetch = network;
  await stopService();
  if (
    bitrixService &&
    bitrixService.exitCode === null &&
    bitrixService.signalCode === null
  ) {
    bitrixService.kill("SIGTERM");
    await bitrixExited;
  }
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await rm(directory, { recursive: true, force: true });
}
