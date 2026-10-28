// Exact stock proposal/install rails + installed bootstrap bundles on isolated files.
// Real HTTP, child processes and flock. systemd and Telegram are synthetic.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  rm,
  symlink,
  readdir,
  chmod,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
const exec = promisify(execFile);
const core = resolve(process.argv[2] || "compat-core"),
  pkg = resolve("plugin");
const base = await mkdtemp(join(tmpdir(), "panels-install-"));
const home = join(base, "user"),
  iva = join(home, "iva"),
  data = join(iva, "data"),
  root = join(iva, "versions/0.5.7-ae313753a1ae"),
  current = join(iva, "current"),
  bin = join(base, "bin");
let child;
const servers = [];
async function listen(handler) {
  const s = createServer(handler);
  servers.push(s);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${s.address().port}`;
}
try {
  await mkdir(join(root, "bin"), { recursive: true });
  await mkdir(join(data, "custom/plugins/peer"), { recursive: true });
  await mkdir(bin);
  await symlink(root, current);
  const peer = {
    name: "peer",
    source: "synthetic",
    ref: "",
    sha: "",
    digest: "",
    enabled: true,
    trusted: false,
    installedAt: "2026-01-01T00:00:00.000Z",
  };
  await writeFile(
    join(data, "custom/plugins.json"),
    JSON.stringify({ version: 1, marketplaces: [], plugins: [peer] }),
  );
  await writeFile(
    join(data, "custom/plugins/peer/plugin.json"),
    JSON.stringify({ name: "peer", version: "1.0.0" }),
  );
  const names = [
    "scripts/cli/plugin.ts",
    "scripts/cli/plugin-cli-context.ts",
    "scripts/cli/plugin-cli-trust.ts",
    "scripts/cli/runtime.ts",
    "scripts/lib/plugin-core.ts",
    "scripts/lib/version-update.ts",
    "scripts/lib/version-store.ts",
    "scripts/lib/plugin-build.ts",
    "scripts/lib/plugin-units.ts",
    "scripts/update-finish.ts",
    "scripts/poller/config.ts",
    "scripts/telegram-poll.mjs",
  ];
  const sourceBefore = {};
  for (const name of names) {
    const p = join(root, name);
    await mkdir(join(p, ".."), { recursive: true });
    const b = await readFile(join(core, name));
    await writeFile(p, b);
    sourceBefore[name] = b;
  }
  const ordinary = [];
  const eve = await listen(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    if (req.url === "/eve/v1/health") {
      res.writeHead(200);
      res.end('{"ok":true}');
    } else {
      ordinary.push(b);
      res.writeHead(204, { "x-iva-telegram-acceptance": "turn" });
      res.end();
    }
  });
  const sends = [];
  const bot = await listen(async (req, res) => {
    let b = "";
    for await (const c of req) b += c;
    sends.push({ method: req.url, body: JSON.parse(b) });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        result: req.url.endsWith("sendMessage") ? { message_id: 500 } : true,
      }),
    );
  });
  await writeFile(
    join(root, ".env"),
    `TELEGRAM_BOT_TOKEN=42:synthetic\nTELEGRAM_WEBHOOK_SECRET_TOKEN=synthetic-secret-123\nTELEGRAM_ALLOWED_USER_IDS=42\nASSISTANT_DATA_DIR=${data}\nASSISTANT_HOST=${eve}\n`,
    { mode: 0o600 },
  );
  const route = join(
    home,
    ".config/systemd/user/iva-telegram-poll.service.d/90-iva-panels-installer.conf",
  );
  const stub = `#!/usr/bin/env node\nimport{existsSync,readFileSync,appendFileSync}from'node:fs';const a=process.argv.slice(2);appendFileSync(${JSON.stringify(join(base, "systemd-calls.jsonl"))},JSON.stringify([process.argv[1],a])+'\\n');if(process.argv[1].endsWith('systemctl')){if(a.includes('WorkingDirectory')||a.includes('--property=WorkingDirectory'))console.log(${JSON.stringify(current)});else if(a.includes('--property=DropInPaths'))console.log(existsSync(${JSON.stringify(route)})?${JSON.stringify(route)}:'');else if(a.includes('--property=ExecStart'))console.log(existsSync(${JSON.stringify(route)})?readFileSync(${JSON.stringify(route)},'utf8'):'node --env-file=.env scripts/telegram-poll.mjs');else if(a.includes('cat'))console.log('[Service]\\nWorkingDirectory='+${JSON.stringify(current)}+'\\nExecStart=node --env-file=.env scripts/telegram-poll.mjs');else if(a.includes('is-active'))console.log('active');}\n`;
  for (const name of ["systemctl", "systemd-run"]) {
    await writeFile(join(bin, name), stub);
    await chmod(join(bin, name), 0o700);
  }
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH}`,
    ASSISTANT_DATA_DIR: data,
  };
  // Use actual stock dispatcher and proposal store; only systemd and sends are substituted.
  const driver = `import{writeFile}from'node:fs/promises';import{createCliRuntime}from${JSON.stringify(pathToFileURL(join(core, "scripts/cli/runtime.ts")).href)};import{createPluginCommands}from${JSON.stringify(pathToFileURL(join(core, "scripts/cli/plugin.ts")).href)};const base=createCliRuntime(${JSON.stringify(current)});const runtime={...base,hasSystemd:()=>false};const{cmdPlugin}=createPluginCommands(runtime,{interactive:()=>false,translate:en=>en,log:()=>{},sends:{screen:async(_t,_c,text)=>{await writeFile(${JSON.stringify(join(base, "proposal.txt"))},text);return{ok:true};},text:async()=>({ok:true})}});await cmdPlugin(process.argv.slice(3));`;
  await writeFile(join(root, "bin/iva.mjs"), driver);
  const call = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [join(pkg, "sh.iva/services/router/install.mjs"), ...args],
          { env, timeout: 45000 },
        )
      ).stdout,
    );
  assert.equal((await call("plan")).state, "ready_to_propose");
  assert.equal((await call("propose")).state, "proposal_sent");
  assert.equal((await call("propose")).state, "proposal_already_sent");
  assert.equal(
    JSON.parse(await readFile(join(data, "custom/plugins.json"))).plugins
      .length,
    1,
    "proposal must not install or grant trust",
  );
  const folders = await readdir(join(data, "plugin-proposals"));
  const folder = folders.find((n) => /^iva-panels-[a-f0-9]{12}$/.test(n));
  assert(folder);
  const digest12 = folder.slice(-12);
  const { handlePluginProposalTap } = await import(
    pathToFileURL(join(core, "scripts/poller/plugin-proposal-tap.ts")).href
  );
  const launch = [];
  assert.equal(
    await handlePluginProposalTap(
      { digest12, chatId: 42 },
      {
        dataDir: data,
        translate: (en) => en,
        replyImpl: async () => {},
        launch: async (_unit, args) => {
          launch.push(args);
          await exec(
            process.execPath,
            [join(current, "bin/iva.mjs"), ...args],
            { env, timeout: 45000 },
          );
          return { ok: true };
        },
      },
    ),
    "started",
  );
  assert.deepEqual(launch, [["plugin", "install-proposal", digest12]]);
  const registry = JSON.parse(
    await readFile(join(data, "custom/plugins.json")),
  );
  const installed = registry.plugins.find((p) => p.name === "iva-panels");
  assert(installed.enabled && installed.trusted);
  assert.deepEqual(
    registry.plugins.find((p) => p.name === "peer"),
    peer,
  );
  const port = installed.services.router.port,
    installedRoot = join(data, "custom/plugins/iva-panels"),
    directory = join(data, "plugin-data/iva-panels");
  const preload = join(base, "preload.mjs");
  await writeFile(
    preload,
    `const network=globalThis.fetch;globalThis.fetch=(url,init)=>{const u=new URL(String(url));if(u.hostname==='api.telegram.org')return network(${JSON.stringify(bot)}+'/'+u.pathname.split('/').at(-1),init);if(u.hostname!=='127.0.0.1')throw new Error('Unexpected network');return network(url,init);};`,
  );
  child = spawn(
    process.execPath,
    [join(installedRoot, "sh.iva/services/router/server.mjs")],
    {
      env: {
        ...env,
        NODE_OPTIONS: `--import=${preload}`,
        PLUGIN_ROOT: installedRoot,
        PLUGIN_DATA: directory,
        IVA_DATA_DIR: data,
        IVA_SERVICE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let logs = "";
  child.stdout.on("data", (b) => (logs += b));
  child.stderr.on("data", (b) => (logs += b));
  for (let i = 0; i < 160; i++) {
    try {
      const s = JSON.parse(await readFile(join(directory, "setup.json")));
      if (s.phase === "connected" && s.notice === "presented") break;
    } catch {}
    if (child.exitCode !== null)
      throw new Error("Installed service exited: " + logs);
    if (i === 159) throw new Error("Setup did not finish: " + logs);
    await new Promise((r) => setTimeout(r, 50));
  }
  const welcome = sends.find((s) => s.method === "/sendMessage");
  assert(welcome?.body.text.includes("Panels готовы"));
  assert.equal(
    welcome.body.reply_markup.inline_keyboard[0][0].text,
    "Открыть панели",
  );
  const click = {
    update_id: 1,
    callback_query: {
      id: "synthetic-install-card",
      data: welcome.body.reply_markup.inline_keyboard[0][0].callback_data,
      from: { id: 42, is_bot: false },
      message: { message_id: 500, chat: { id: 42, type: "private" } },
    },
  };
  const response = await fetch(
    `http://127.0.0.1:${port}/eve/v1/telegram/accepted`,
    {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "synthetic-secret-123" },
      body: JSON.stringify(click),
    },
  );
  assert.equal(response.status, 204);
  assert.equal(ordinary.length, 0);
  assert(
    sends.some(
      (s) => s.method === "/editMessageText" && s.body.text.includes("Плагины"),
    ),
  );
  const text = {
    update_id: 2,
    message: {
      message_id: 501,
      from: { id: 42, is_bot: false },
      chat: { id: 42, type: "private" },
      text: "ordinary after installation",
    },
  };
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${port}/eve/v1/telegram/accepted`, {
        method: "POST",
        body: JSON.stringify(text),
      })
    ).status,
    204,
  );
  assert.deepEqual(JSON.parse(ordinary.at(-1)), text);
  assert(!logs.includes("synthetic-secret") && !logs.includes("42:synthetic"));
  const recovery = join(directory, "installer-recovery.mjs");
  assert((await readFile(recovery)).length > 1000);
  const disconnected = await exec(
    "/usr/bin/flock",
    [
      "--nonblock",
      "--no-fork",
      join(directory, "setup.lock"),
      process.execPath,
      recovery,
      "internal-disconnect",
      data,
    ],
    { env, timeout: 30000 },
  );
  assert.equal(JSON.parse(disconnected.stdout).state, "rolled_back");
  assert(
    !(await readdir(join(route, ".."))).includes(
      "90-iva-panels-installer.conf",
    ),
  );
  for (const [name, bytes] of Object.entries(sourceBefore))
    assert(
      (await readFile(join(root, name))).equals(bytes),
      "core source changed",
    );
  assert.deepEqual(
    JSON.parse(await readFile(join(data, "custom/plugins.json"))).plugins.find(
      (p) => p.name === "peer",
    ),
    peer,
  );
  console.log(
    "Stock 0.5.7 proposal -> native tap/install -> production bootstrap/ready card -> bound menu/ordinary forwarding -> persistent recovery passed; systemd/Telegram synthetic, no live Iva acceptance.",
  );
} finally {
  if (child && child.exitCode === null) {
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await done;
  }
  for (const s of servers) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  await rm(base, { recursive: true, force: true });
}
