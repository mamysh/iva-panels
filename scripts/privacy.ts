import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const privateName =
  /(^|\/)(AGENTS\.md|LOCAL_PROJECT_MEMORY\.md|PRIVATE_PLAN\.md|\.env(?:\..+)?|config\.json|screens\.json)$/;
function inspect(text: string, location: string) {
  if (
    /\/Users\/|\/home\/(?!runner\/)|https:\/\/[^\s"']+\/rest\/\d+\//.test(text)
  )
    throw new Error(`Private local path or webhook: ${location}`);
  if (
    /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      text,
    )
  )
    throw new Error(`Potential secret: ${location}`);
}
const files = new Set(
  execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean),
);
for (const name of files) {
  if (privateName.test(name) && !name.endsWith(".env.example"))
    throw new Error(`Private file in distribution: ${name}`);
  inspect(readFileSync(name, "utf8"), name);
}
// Scan reachable local history without ever printing matched content.
const lines = execFileSync("git", ["rev-list", "--objects", "--all"], {
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
})
  .trim()
  .split("\n")
  .filter(Boolean);
const ids = new Set<string>();
for (const line of lines) {
  const [id, ...parts] = line.split(" ");
  const name = parts.join(" ");
  if (privateName.test(name) && !name.endsWith(".env.example"))
    throw new Error(`Private historical file at object ${id}`);
  ids.add(id);
}
if (ids.size) {
  const batch = execFileSync("git", ["cat-file", "--batch"], {
    input: [...ids].join("\n") + "\n",
    maxBuffer: 128 * 1024 * 1024,
  });
  let offset = 0;
  while (offset < batch.length) {
    const end = batch.indexOf(10, offset);
    if (end < 0) throw new Error("Invalid Git object stream");
    const [id, type, size] = batch.subarray(offset, end).toString().split(" ");
    const length = Number(size);
    if (!Number.isSafeInteger(length) || length < 0)
      throw new Error("Invalid Git object size");
    if (["blob", "commit", "tag"].includes(type))
      inspect(
        batch.subarray(end + 1, end + 1 + length).toString("utf8"),
        `Git object ${id}`,
      );
    offset = end + 1 + length + 1;
  }
}
console.log(
  `Privacy check passed (${files.size} files, ${ids.size} reachable Git objects; heuristic scan)`,
);
