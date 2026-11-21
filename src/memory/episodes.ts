import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import picomatch from "picomatch";
import type { HarnessConfig } from "../core/config.js";

/**
 * MEMORIA EPISÓDICA (el "diario") y PROCEDURAL (las "reglas de la pared").
 * Vive DENTRO del repo del sistema, versionada con git. Por defecto:
 *   .harness/memory/episodes/   un .md por ticket resuelto (se commitea con el PR)
 *   .harness/memory/incidents/  post-mortems de hotfix
 *   .harness/memory/lessons/pending/   lecciones propuestas (las aprueba un humano)
 *   .harness/memory/lessons/approved.md
 * En modo adaptador las rutas salen de `memory` en la config, y la búsqueda
 * recorre la historia que el repo ya tenía (`memory.searchPaths`).
 */

type MemCfg = HarnessConfig["memory"];
const DEFAULT_MEM: MemCfg = {
  searchPaths: [".harness/memory/episodes/*.md", ".harness/memory/incidents/*.md"],
  episodesDir: ".harness/memory/episodes",
  incidentsDir: ".harness/memory/incidents",
  filePrefix: "",
  approvedLessons: ".harness/memory/lessons/approved.md",
  pendingLessonsDir: ".harness/memory/lessons/pending",
};
const mem = (cfg?: HarnessConfig): MemCfg => cfg?.memory ?? DEFAULT_MEM;

export interface Episode {
  ticketId: string;
  title: string;
  lane: string;
  finalLane: string;
  outcome: "merged-pending-review" | "escalated" | "answered";
  modules: string[];
  files: string[];
  commit: string;
  attempts: number;
  symptom: string;
  rootCause: string;
  fix: string;
  notWorked: string;
  date: string;
}

function slug(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

function yamlList(xs: string[]): string {
  return `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
}

export function writeEpisode(repoDir: string, e: Episode, kind: "episodes" | "incidents" = "episodes", cfg?: HarnessConfig): string {
  const m = mem(cfg);
  const dir = join(repoDir, kind === "episodes" ? m.episodesDir : m.incidentsDir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${m.filePrefix}${e.date.slice(0, 10)}-${slug(e.ticketId)}-${slug(e.title).slice(0, 30)}.md`);
  const md = `---
ticket: ${JSON.stringify(e.ticketId)}
title: ${JSON.stringify(e.title)}
lane: ${e.lane}
final_lane: ${e.finalLane}
outcome: ${e.outcome}
modules: ${yamlList(e.modules)}
files: ${yamlList(e.files)}
commit: ${e.commit}
attempts: ${e.attempts}
date: ${e.date}
---

## Síntoma
${e.symptom}

## Causa raíz
${e.rootCause}

## Solución
${e.fix}

## Qué no funcionó
${e.notWorked || "—"}
`;
  writeFileSync(file, md);
  return file;
}

export interface SearchHit {
  path: string;
  score: number;
  ticket: string;
  title: string;
  excerpt: string;
  stale: boolean;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 2);
}

function frontmatter(md: string, key: string): string {
  const m = md.match(new RegExp(`^${key}:\\s*(.*)$`, "m"));
  return m ? m[1].replace(/^"|"$/g, "") : "";
}

/** Expande globs relativos al repo (sin dependencias: recorre solo la carpeta fija de cada patrón). */
export function expandGlobs(repoDir: string, patterns: string[]): string[] {
  const out = new Set<string>();
  for (const pat of patterns) {
    const fixed = pat.split("/").filter((seg) => !/[*?[{]/.test(seg));
    const firstGlob = pat.split("/").findIndex((seg) => /[*?[{]/.test(seg));
    const root = join(repoDir, ...(firstGlob < 0 ? fixed.slice(0, -1) : pat.split("/").slice(0, firstGlob)));
    if (!existsSync(root)) continue;
    const isMatch = picomatch(pat, { dot: false });
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name.startsWith(".git")) continue;
        const abs = join(dir, name);
        const st = statSync(abs);
        if (st.isDirectory()) walk(abs, depth + 1);
        else {
          const rel = relative(repoDir, abs);
          if (isMatch(rel)) out.add(rel);
        }
      }
    };
    walk(root, 0);
  }
  return [...out].sort();
}

/**
 * Búsqueda simple por texto (BM25-lite) sobre la historia del repo.
 * Con un par de miles de documentos alcanza; cuando deje de alcanzar,
 * cambiá esta función por embeddings sin tocar el resto.
 */
export function searchMemory(
  repoDir: string,
  query: string,
  opts: { module?: string; limit?: number; existingFiles?: (f: string) => boolean; cfg?: HarnessConfig } = {},
): SearchHit[] {
  const q = tokens(query);
  if (q.length === 0) return [];
  const docs = expandGlobs(repoDir, mem(opts.cfg).searchPaths).map((path) => ({ path, text: readFileSync(join(repoDir, path), "utf8") }));
  const N = docs.length || 1;
  const df = new Map<string, number>();
  const docTokens = docs.map((d) => {
    const ts = tokens(d.path + " " + d.text);
    new Set(ts).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1));
    return ts;
  });

  const hits: SearchHit[] = docs.map((d, i) => {
    const ts = docTokens[i];
    const len = ts.length || 1;
    let score = 0;
    for (const t of q) {
      let tf = 0;
      for (const x of ts) if (x === t) tf++;
      if (tf) score += ((tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (len / 800)))) * Math.log(1 + N / (df.get(t) ?? 1));
    }
    if (opts.module && (frontmatter(d.text, "modules").includes(opts.module) || d.path.includes(opts.module))) score *= 1.5;
    if (/incident|incidente|hotfix/i.test(d.path)) score *= 1.2;
    const files = (frontmatter(d.text, "files").match(/"([^"]+)"/g) ?? []).map((x) => x.slice(1, -1));
    const stale = opts.existingFiles ? files.length > 0 && files.every((f) => !opts.existingFiles!(f)) : false;
    const hasFm = d.text.startsWith("---");
    const body = (hasFm ? d.text.split(/^---$/m).slice(2).join("---") : d.text).trim();
    const heading = body.match(/^#+\s+(.+)$/m)?.[1] ?? "";
    return {
      path: d.path,
      score: stale ? score * 0.5 : score,
      ticket: frontmatter(d.text, "ticket") || d.path.replace(/^.*\//, "").replace(/\.md$/, ""),
      title: frontmatter(d.text, "title") || heading,
      excerpt: body.slice(0, 700),
      stale,
    };
  });

  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3);
}

export function proposeLesson(
  repoDir: string,
  lesson: { title: string; rule: string; evidence: string; module?: string; ticketId?: string },
  cfg?: HarnessConfig,
): string {
  const dir = join(repoDir, mem(cfg).pendingLessonsDir);
  mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString();
  const file = join(dir, `${date.slice(0, 10)}-${slug(lesson.title)}.md`);
  writeFileSync(
    file,
    `---
title: ${JSON.stringify(lesson.title)}
module: ${JSON.stringify(lesson.module ?? "")}
ticket: ${JSON.stringify(lesson.ticketId ?? "")}
proposed: ${date}
status: pending
---

## Regla
${lesson.rule}

## Evidencia
${lesson.evidence}

> Pendiente de aprobación humana. Para aprobarla, pasala a ${mem(cfg).approvedLessons} en un PR/MR.
`,
  );
  return file;
}

export function approvedLessons(repoDir: string, module?: string, cfg?: HarnessConfig): string {
  const p = join(repoDir, mem(cfg).approvedLessons);
  if (!existsSync(p)) return "No hay lecciones aprobadas todavía.";
  const text = readFileSync(p, "utf8");
  if (!module) return text;
  const sections = text.split(/^## /m);
  const relevant = sections.filter((s, i) => i === 0 || s.toLowerCase().includes(module.toLowerCase()) || /^general/i.test(s));
  return relevant.map((s, i) => (i === 0 ? s : `## ${s}`)).join("");
}
