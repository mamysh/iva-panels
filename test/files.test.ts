import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  filePage,
  fileUpdateCheck,
} from "../plugin/sh.iva/services/router/files.ts";
import { installedPanels } from "../plugin/sh.iva/services/router/providers.ts";
import { viewSchema } from "../plugin/sh.iva/services/router/contracts.ts";
const old = "a".repeat(40),
  candidate = "b".repeat(40);
async function fixture(
  t: { after: (fn: () => Promise<void>) => void },
  version = "0.3.2",
) {
  const data = await mkdtemp(join(tmpdir(), "panels-files-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  await mkdir(join(data, "custom/plugins/file-delivery"), { recursive: true });
  await writeFile(
    join(data, "custom/plugins/file-delivery/plugin.json"),
    JSON.stringify({ name: "file-delivery", version }),
  );
  await writeFile(
    join(data, "custom/plugins.json"),
    JSON.stringify({
      plugins: [
        { name: "file-delivery", enabled: true, trusted: true, sha: old },
      ],
    }),
  );
  return data;
}
test("file pages are local until explicit check; unknown version and malformed manifest do not claim known limits", async (t) => {
  const data = await fixture(t);
  let calls = 0;
  const check = async () => {
    calls++;
    return "synthetic check";
  };
  for (const id of ["file-delivery", "files:rules", "files:updates"])
    viewSchema.parse(await filePage(data, id, old, check));
  assert.equal(calls, 0);
  assert.match(
    (await filePage(data, "files:rules", old, check)).body,
    /50 МиБ/,
  );
  await filePage(data, "files:check", old, check);
  assert.equal(calls, 1);
  const path = join(data, "custom/plugins/file-delivery/plugin.json");
  await writeFile(
    path,
    JSON.stringify({ name: "file-delivery", version: "0.4.0" }),
  );
  assert.doesNotMatch(
    (await filePage(data, "files:rules", old, check)).body,
    /50 МиБ/,
  );
  await writeFile(path, JSON.stringify({ name: "other", version: "0.3.2" }));
  await filePage(data, "files:check", old, check);
  assert.equal(calls, 1);
  await assert.rejects(filePage(data, "files:install", old, check));
});
test("file actions check enabled/trusted every time; check failures preserve back navigation", async (t) => {
  const data = await fixture(t);
  const check = async () => {
    throw new Error("secret synthetic error");
  };
  const provider = installedPanels(
    data,
    false,
    undefined,
    false,
    undefined,
    check,
  );
  const page = viewSchema.parse(await provider.page("files:check"));
  assert.doesNotMatch(page.body, /secret/);
  assert.equal(page.rows[1][0].id, "file-delivery");
  await writeFile(
    join(data, "custom/plugins.json"),
    JSON.stringify({
      plugins: [{ name: "file-delivery", enabled: true, trusted: false }],
    }),
  );
  assert((await provider.page("files:check")).body.includes("не разрешено"));
});
function network(responses: unknown[]) {
  const urls: string[] = [];
  const request = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    assert.equal(init?.redirect, "error");
    assert(init?.signal);
    assert(!Object.keys(init!.headers!).some((k) => /authorization/i.test(k)));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as typeof fetch;
  return { request, urls };
}
const run = {
  head_sha: candidate,
  path: ".github/workflows/ci.yml",
  event: "push",
  status: "completed",
  conclusion: "success",
  run_number: 9,
  run_attempt: 1,
};
test("stable check pins manifest and CI to SHA, selects latest push CI, distinguishes newer version", async () => {
  const n = network([
    { sha: candidate },
    { name: "file-delivery", version: "0.3.3" },
    {
      workflow_runs: [
        { ...run, run_number: 8, conclusion: "failure" },
        {
          ...run,
          path: ".github/workflows/other.yml",
          run_number: 10,
          conclusion: "failure",
        },
        run,
      ],
    },
  ]);
  const body = await fileUpdateCheck(n.request)("0.3.2", old);
  assert.match(body, /CI stable: успешен/);
  assert.match(body, /более новая версия/);
  assert(n.urls[1].includes(candidate));
  assert(n.urls[2].includes(`head_sha=${candidate}`));
  const same = network([
    { sha: candidate },
    { name: "file-delivery", version: "0.3.2" },
    { workflow_runs: [run] },
  ]);
  assert.match(
    await fileUpdateCheck(same.request)("0.3.2", candidate),
    /commit совпадает/,
  );
  assert.equal(same.urls.length, 3);
  const equal = network([
    { sha: candidate },
    { name: "file-delivery", version: "0.3.2" },
    { workflow_runs: [] },
  ]);
  assert.match(
    await fileUpdateCheck(equal.request)("0.3.2", old),
    /Более новая версия не обнаружена/,
  );
});
test("pending/failed/missing CI and invalid/bounded responses never imply successful check", async () => {
  for (const [runs, status] of [
    [[{ ...run, status: "in_progress", conclusion: null }], "ещё выполняется"],
    [[{ ...run, conclusion: "failure" }], "не прошёл"],
    [[], "не найден"],
  ] as const) {
    const n = network([
      { sha: candidate },
      { name: "file-delivery", version: "0.3.3" },
      { workflow_runs: runs },
    ]);
    assert((await fileUpdateCheck(n.request)("0.3.2", old)).includes(status));
  }
  await assert.rejects(
    fileUpdateCheck(network([{ sha: "bad" }]).request)("0.3.2", old),
  );
  await assert.rejects(
    fileUpdateCheck(
      network([{ sha: candidate }, { name: "other", version: "0.3.3" }])
        .request,
    )("0.3.2", old),
  );
  const huge = (async () =>
    new Response("x".repeat(130 * 1024))) as typeof fetch;
  await assert.rejects(fileUpdateCheck(huge)("0.3.2", old), /TOO_LARGE/);
  await assert.rejects(
    fileUpdateCheck(
      (async () => new Response("{}", { status: 429 })) as typeof fetch,
    )("0.3.2", old),
  );
});
