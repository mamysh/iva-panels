import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realpath, readdir, lstat, readFile, mkdir } from "node:fs/promises";
import {
  setupState,
  prepareSetup,
  activateSetup,
  rollbackSetup,
  noticeSetup,
  retrySetup,
  digest,
  privateFile,
  durableWrite,
} from "./setup.ts";
import {
  systemSetupIO,
  discoverSetup,
  preflightInstall,
  command,
  setupWorker,
} from "./setup-system.ts";

/** A lost native proposal send is never automatically issued a second time. */
export async function proposePackage(
  data: string,
  current: string,
  packageRoot: string,
  invoke = command,
) {
  const files: string[] = [];
  async function walk(path: string, prefix = "") {
    for (const name of (await readdir(path)).sort()) {
      const p = join(path, name),
        info = await lstat(p);
      if (info.isDirectory()) await walk(p, `${prefix}${name}/`);
      else if (info.isFile() && info.size <= 16 * 1024 * 1024)
        files.push(`${prefix}${name}:${digest(await readFile(p))}`);
      else throw new Error("SETUP_PACKAGE_UNSAFE");
    }
  }
  await walk(packageRoot);
  const directory = join(data, "plugin-proposals");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const marker = join(
    directory,
    `panels-setup-${digest(files.join("\n")).slice(0, 24)}.json`,
  );
  const previous = await privateFile(marker);
  if (previous !== undefined)
    return {
      state:
        JSON.parse(previous).state === "sent"
          ? "proposal_already_sent"
          : "proposal_delivery_unknown",
      next: "Не повторяйте отправку. Проверьте прежнюю штатную карточку установки и фактическую регистрацию плагина.",
    };
  await durableWrite(marker, JSON.stringify({ state: "attempted" }), true);
  try {
    await invoke(
      process.execPath,
      [join(current, "bin/iva.mjs"), "plugin", "propose", packageRoot],
      30000,
    );
    await durableWrite(marker, JSON.stringify({ state: "sent" }));
    return {
      state: "proposal_sent",
      next: "Дождитесь настоящего нажатия владельца на штатную кнопку установки. Не вызывайте install-proposal и не записывайте доверие вручную.",
    };
  } catch {
    throw new Error("SETUP_PROPOSAL_DELIVERY_UNKNOWN");
  }
}
export async function runInstaller(
  args: string[],
  packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
) {
  const [op, dataArg, ...extra] = args;
  if (extra.length) throw new Error("SETUP_ARGUMENTS");
  if (op?.startsWith("internal-")) {
    if (
      !dataArg?.startsWith("/") ||
      (await realpath(dataArg)) !== resolve(dataArg)
    )
      throw new Error("SETUP_DATA_MISMATCH");
    const io = systemSetupIO(
      dataArg,
      join(dataArg, "custom/plugins/iva-panels"),
    );
    if (op === "internal-prepare") return { prepared: await prepareSetup(io) };
    if (op === "internal-activate") return { id: await activateSetup(io) };
    if (op === "internal-rollback" || op === "internal-disconnect") {
      await rollbackSetup(io, op === "internal-disconnect");
      return {
        state: (await setupState(io.directory))?.phase ?? "not_configured",
      };
    }
    if (op === "internal-retry") {
      await retrySetup(io);
      return { state: "retry_prepared" };
    }
    if (
      op === "internal-notice-presented" ||
      op === "internal-notice-unknown"
    ) {
      await noticeSetup(
        io,
        op.endsWith("presented") ? "presented" : "delivery_unknown",
      );
      return { state: "recorded" };
    }
    throw new Error("SETUP_ARGUMENTS");
  }
  if (dataArg) throw new Error("SETUP_ARGUMENTS");
  if (op === "plan" || op === "propose") {
    const result = await preflightInstall(packageRoot);
    if (op === "plan" || result.state !== "ready_to_propose")
      return {
        state: result.state,
        core: "0.5.7/ae313753a1ae",
        automaticRoutingAfterApproval: true,
        independentRollbackSeconds: 120,
      };
    return proposePackage(result.data, result.current, packageRoot);
  }
  const discovered = await discoverSetup();
  const state = await setupState(
    join(discovered.data, "plugin-data/iva-panels"),
  );
  if (op === "status")
    return {
      state: state?.phase ?? "manual_or_not_configured",
      notice: state?.notice ?? "none",
      automaticReplay: false,
    };
  if (op === "retry") {
    await setupWorker(
      join(discovered.data, "custom/plugins/iva-panels"),
      discovered.data,
      "internal-retry",
    );
    await command("systemctl", [
      "--user",
      "restart",
      "iva-plugin-iva-panels-router.service",
    ]);
    return {
      state: "retry_requested",
      next: "Проверьте status; перезапуск сам по себе не означает готовность.",
    };
  }
  if (op === "disconnect")
    return setupWorker(
      join(discovered.data, "custom/plugins/iva-panels"),
      discovered.data,
      "internal-disconnect",
    );
  throw new Error("SETUP_ARGUMENTS");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await runInstaller(process.argv.slice(2))));
  } catch (error) {
    const code = /^SETUP_[A-Z_]+$/.test((error as Error).message)
      ? (error as Error).message
      : "SETUP_UNAVAILABLE";
    console.log(
      JSON.stringify({
        error: code,
        next: "Ничего не повторяйте автоматически. Проверьте status; нестандартная конфигурация требует проверки оператора.",
      }),
    );
    process.exitCode = 1;
  }
}
