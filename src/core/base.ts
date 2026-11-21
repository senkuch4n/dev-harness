import { execFileSync } from "node:child_process";
import type { HarnessConfig } from "./config.js";
import type { Lane } from "./types.js";

function revExists(repoDir: string, rev: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: repoDir, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Rev de la rama base: `<remote>/<baseBranch>` si existe, si no la rama local. */
export function baseRev(repoDir: string, cfg: HarnessConfig, lane?: Lane): string {
  const branch = (lane && cfg.lanes.base[lane]) || cfg.baseBranch;
  const remote = `${cfg.remote}/${branch}`;
  return revExists(repoDir, remote) ? remote : branch;
}

/** merge-base entre HEAD y la base (lo que la base sumó después no cuenta). */
export function mergeBase(repoDir: string, cfg: HarnessConfig, lane?: Lane): string {
  try {
    return execFileSync("git", ["merge-base", "HEAD", baseRev(repoDir, cfg, lane)], { cwd: repoDir, encoding: "utf8" }).trim();
  } catch {
    return "HEAD";
  }
}

export function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k] : m));
}
