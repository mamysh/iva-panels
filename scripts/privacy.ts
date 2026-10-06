import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean);
for (const name of new Set(files)) {
  if (
    /(^|\/)(AGENTS\.md|LOCAL_PROJECT_MEMORY\.md|PRIVATE_PLAN\.md|\.env|config\.json|screens\.json)$/.test(
      name,
    )
  )
    throw new Error("Private runtime or memory file in distribution");
  const text = readFileSync(name, "utf8");
  if (
    /\/Users\/|\/home\/(?!runner\/)|https:\/\/[^\s"']+\/rest\/\d+\//.test(text)
  )
    throw new Error("Private local path or webhook in distribution");
  if (
    /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b|gh[pousr]_[A-Za-z0-9]{30,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(
      text,
    )
  )
    throw new Error("Potential secret in distribution");
}
console.log(`Privacy check passed (${new Set(files).size} files)`);
