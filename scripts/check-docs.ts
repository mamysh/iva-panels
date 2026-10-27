import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, extname } from "node:path";
const files = [
  ...new Set(
    execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter(Boolean),
  ),
];
function anchors(text: string) {
  const seen = new Map<string, number>();
  const ids = new Set<string>();
  for (const line of text.replace(/```[\s\S]*?```/g, "").split("\n")) {
    const match = /^#{1,6}\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const id = match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/`/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\-\s]/gu, "")
      .replace(/\s/g, "-");
    const count = seen.get(id) ?? 0;
    seen.set(id, count + 1);
    ids.add(id + (count ? `-${count}` : ""));
  }
  return ids;
}
let count = 0;
const errors: string[] = [];
for (const file of files.filter((f) => f.endsWith(".md"))) {
  const text = readFileSync(file, "utf8");
  const links = [
    ...text.matchAll(/\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g),
    ...text.matchAll(/(?:src|href)="([^"]+)"/g),
  ].map((m) => m[1]);
  for (const link of links) {
    if (/^(?:[a-z]+:|\/\/)/i.test(link)) continue;
    const [target, fragment] = decodeURIComponent(link).split("#");
    const path = target ? resolve(dirname(file), target) : resolve(file);
    count++;
    if (!existsSync(path)) errors.push(`${file}: missing target ${link}`);
    else if (
      fragment &&
      extname(path) === ".md" &&
      statSync(path).isFile() &&
      !anchors(readFileSync(path, "utf8")).has(fragment)
    )
      errors.push(`${file}: missing anchor ${link}`);
  }
}
if (errors.length) throw new Error(errors.join("\n"));
console.log(`Documentation links passed (${count} local targets)`);
