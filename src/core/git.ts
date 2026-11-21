import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

function git(repoDir: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** Archivos cambiados respecto de la rama base: commits + staged + sin commitear + nuevos. */
export function changedFiles(repoDir: string, baseBranch: string): string[] {
  const base =
    git(repoDir, ["merge-base", "HEAD", `origin/${baseBranch}`]) ||
    git(repoDir, ["merge-base", "HEAD", baseBranch]);
  const committed = base ? git(repoDir, ["diff", "--name-only", `${base}...HEAD`]) : "";
  const working = git(repoDir, ["diff", "--name-only", "HEAD"]);
  const untracked = git(repoDir, ["ls-files", "--others", "--exclude-standard"]);
  const files = [committed, working, untracked]
    .join("\n")
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean)
    .filter((f) => !f.startsWith(".harness/run/"));
  return [...new Set(files)].sort();
}

/** Hash del contenido del diff: si cambia, el gate anterior ya no vale. */
export function diffHash(repoDir: string, baseBranch: string): string {
  const files = changedFiles(repoDir, baseBranch).filter((f) => !f.startsWith(".harness/memory/"));
  const head = git(repoDir, ["rev-parse", "HEAD"]);
  const content = git(repoDir, ["diff", "HEAD", "--", ...files]);
  return createHash("sha256").update(head).update(files.join("\n")).update(content).digest("hex").slice(0, 16);
}

export function headSha(repoDir: string): string {
  return git(repoDir, ["rev-parse", "--short", "HEAD"]);
}

export function currentBranch(repoDir: string): string {
  return git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export function repoKey(repoDir: string): string {
  const remote = git(repoDir, ["config", "--get", "remote.origin.url"]);
  const top = git(repoDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) || repoDir;
  const source = remote || top;
  return source.replace(/^.*[/:]([^/:]+\/[^/]+?)(\.git)?$/, "$1").replace(/[^\w.-]+/g, "_");
}
