import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

/**
 * OK humano para pushear riesgo alto, atado al HEAD exacto.
 * Vive en el worktree (.harness/run/, ignorado por git): cada worktree tiene el suyo.
 */
const FILE = ".harness/run/ok-humano.json";

export interface HumanOk {
  head: string;
  approvedBy: string;
  quote: string;
  at: string;
}

function head(repoDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

export function writeHumanOk(repoDir: string, approvedBy: string, quote: string): HumanOk {
  const ok: HumanOk = { head: head(repoDir), approvedBy, quote, at: new Date().toISOString() };
  const p = join(repoDir, FILE);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ok, null, 2));
  return ok;
}

export function hasHumanOkForHead(repoDir: string): boolean {
  const p = join(repoDir, FILE);
  if (!existsSync(p)) return false;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as HumanOk).head === head(repoDir);
  } catch {
    return false;
  }
}
