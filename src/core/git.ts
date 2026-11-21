import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function git(repoDir: string, args: string[]): string {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** Archivos cambiados respecto de la rama base (rev): commits + staged + sin commitear + nuevos. */
export function changedFiles(repoDir: string, baseRev: string): string[] {
  const base = git(repoDir, ["merge-base", "HEAD", baseRev]);
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

/**
 * Hash del CONTENIDO del cambio (vs merge-base), no del commit: commitear o
 * amendar no lo invalida; editar código sí. Si cambia, el gate anterior ya no vale.
 */
export function diffHash(repoDir: string, baseRev: string, exclude: string[] = [".harness/"]): string {
  const files = changedFiles(repoDir, baseRev).filter((f) => !exclude.some((p) => f.startsWith(p)));
  const mb = git(repoDir, ["merge-base", "HEAD", baseRev]) || "HEAD";
  const h = createHash("sha256").update(files.join("\n"));
  h.update(git(repoDir, ["diff", mb, "--", ...files]));
  const untracked = new Set(git(repoDir, ["ls-files", "--others", "--exclude-standard", "--", ...files]).split("\n").filter(Boolean));
  for (const f of untracked) {
    try {
      h.update(f).update(readFileSync(join(repoDir, f)));
    } catch {
      /* borrado entre medio */
    }
  }
  return h.digest("hex").slice(0, 16);
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

/** Archivos con cambios sin commitear (o nuevos), ignorando los prefijos dados. */
export function uncommitted(repoDir: string, ignorePrefixes: string[] = []): string[] {
  const out = git(repoDir, ["status", "--porcelain", "--untracked-files=all"]);
  return out
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter(Boolean)
    .map((f) => (f.includes(" -> ") ? f.split(" -> ")[1] : f))
    .filter((f) => !ignorePrefixes.some((p) => f.startsWith(p)));
}
