import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { View } from "./contracts.ts";

const version = z
  .string()
  .regex(/^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-[a-zA-Z0-9.-]{1,24})?$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const manifest = z.object({ name: z.literal("file-delivery"), version });
const repository = "mamysh/iva-file-delivery";
export type FileCheck = (installed: string, commit?: string) => Promise<string>;

// Fixed public repository, no credentials, child process or updater offer.
export function fileUpdateCheck(request: typeof fetch = fetch): FileCheck {
  return async (installed, commit) => {
    const signal = AbortSignal.timeout(15_000);
    async function json(url: string, limit = 128 * 1024) {
      const response = await request(url, {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "iva-panels",
        },
        redirect: "error",
        signal,
      });
      if (!response.ok || !response.body)
        throw new Error("FILE_UPDATE_UNAVAILABLE");
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > limit) throw new Error("FILE_UPDATE_TOO_LARGE");
          parts.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(parts).toString("utf8"));
    }
    const candidate = z
      .object({ sha })
      .parse(
        await json(`https://api.github.com/repos/${repository}/commits/stable`),
      ).sha;
    const latest = manifest.parse(
      await json(
        `https://raw.githubusercontent.com/${repository}/${candidate}/plugin/plugin.json`,
        8192,
      ),
    ).version;
    let summary = `Установлена: ${installed}\nStable: ${latest}\nCommit stable: ${candidate.slice(0, 12)}`;
    const runs = z
      .object({
        workflow_runs: z.array(
          z.object({
            head_sha: sha,
            path: z.string(),
            event: z.string(),
            status: z.string(),
            conclusion: z.string().nullable(),
            run_number: z.number().int().nonnegative(),
            run_attempt: z.number().int().positive(),
          }),
        ),
      })
      .parse(
        await json(
          `https://api.github.com/repos/${repository}/actions/runs?head_sha=${candidate}&per_page=20`,
        ),
      )
      .workflow_runs.filter(
        (r) =>
          r.head_sha === candidate &&
          r.path === ".github/workflows/ci.yml" &&
          r.event === "push",
      )
      .sort(
        (a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt,
      );
    const run = runs[0];
    const ci = !run
      ? "не найден"
      : run.status !== "completed"
        ? "ещё выполняется"
        : run.conclusion === "success"
          ? "успешен"
          : "не прошёл";
    summary += `\nCI stable: ${ci}`;
    if (commit === candidate)
      return `${summary}\n\nУстановленный commit совпадает со stable. Установка не менялась.`;
    if (/^\d+\.\d+\.\d+$/.test(installed) && /^\d+\.\d+\.\d+$/.test(latest)) {
      const a = installed.split(".").map(Number),
        b = latest.split(".").map(Number);
      const index = a.findIndex((n, i) => n !== b[i]);
      summary +=
        index >= 0 && b[index] > a[index]
          ? "\n\nВ stable опубликована более новая версия."
          : "\n\nБолее новая версия не обнаружена; commit может отличаться.";
    } else summary += "\n\nСравните версии перед переходом со своей ветки.";
    return `${summary}\nДля штатной проверки и предложения установки попросите Иву: «Проверь обновление плагина доставки файлов».`;
  };
}

export async function filePage(
  data: string,
  id: string,
  commit: string | undefined,
  check: FileCheck,
): Promise<View> {
  if (
    !["file-delivery", "files:rules", "files:updates", "files:check"].includes(
      id,
    )
  )
    throw new Error("PLUGIN_UNAVAILABLE");
  let installed: string | undefined;
  try {
    const path = join(data, "custom/plugins/file-delivery/plugin.json");
    const info = await stat(path);
    if (!info.isFile() || info.size > 8192)
      throw new Error("FILE_MANIFEST_INVALID");
    installed = manifest.parse(
      JSON.parse(await readFile(path, "utf8")),
    ).version;
  } catch {
    /* Keep a navigable page without guessing installed capabilities. */
  }
  const navigation = [
    { id: "home", label: "К плагинам" },
    { id: "close", label: "Закрыть" },
  ];
  const back = [
    { id: "file-delivery", label: "Отправка файлов" },
    { id: "close", label: "Закрыть" },
  ];
  const known = ["0.3.2", "0.3.3"].includes(installed ?? "");
  const header = `Версия: ${installed ?? "не удалось прочитать"}\nCommit: ${sha.safeParse(commit).success ? commit!.slice(0, 12) : "не указан"}`;
  if (id === "files:rules")
    return {
      title: "Отправка файлов · Правила",
      body: known
        ? "Один файл или группа из 2–10 файлов любых форматов.\nДо 50 МиБ на каждый файл.\n\nОтправка — в текущий личный Telegram-чат владельца. Файл должен находиться в vault/attachments. Отправка не удаляет исходный файл.\n\nЭто правила версий 0.3.2 и 0.3.3; переключателей настроек у неё нет. Доставку здесь не проверяли."
        : "Правила установленной версии не подтверждены. Панель не применяет лимиты другой версии. Проверьте документацию своего выпуска.",
      rows: [back],
    };
  if (id === "files:updates" || id === "files:check") {
    let body = `${header}\n\n«Проверить stable» сравнит публичную стабильную версию и её CI на GitHub. Источник вашей установки может быть закреплён за другой веткой или tag.\n\nДля установки попросите Иву: «Проверь обновление плагина доставки файлов».`;
    if (id === "files:check") {
      if (!installed)
        body =
          "Не удалось прочитать установленную версию. Сравнение не выполнено; попробуйте обновить сведения.";
      else
        try {
          body = await check(
            installed,
            sha.safeParse(commit).success ? commit : undefined,
          );
        } catch {
          body = `${header}\n\nGitHub сейчас не удалось проверить. Обновление не устанавливалось. Попробуйте позже или попросите Иву проверить обновление плагина.`;
        }
    }
    return {
      title: "Отправка файлов · Обновления",
      body,
      rows: [[{ id: "files:check", label: "Проверить stable" }], back],
    };
  }
  return {
    title: "Отправка файлов",
    body: `${header}\n\n${known ? "Отправляет готовые документы в ваш личный чат: по одному или группой." : "Плагин включён и доверен. Возможности этой версии ещё не проверены панелями."}\n\nДоставка и обновление не запускаются при открытии карточки.`,
    rows: [
      [
        { id: "files:rules", label: "Правила отправки" },
        { id: "files:updates", label: "Обновления" },
      ],
      [{ id: "file-delivery", label: "Обновить сведения" }],
      navigation,
    ],
  };
}
