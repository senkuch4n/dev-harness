import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * MEMORIA EPISÓDICA (el "diario") y PROCEDURAL (las "reglas de la pared").
 * Vive DENTRO del repo del sistema, versionada con git:
 *   .harness/memory/episodes/   un .md por ticket resuelto (se commitea con el PR)
 *   .harness/memory/incidents/  post-mortems de hotfix
 *   .harness/memory/lessons/pending/   lecciones propuestas (las aprueba un humano)
 *   .harness/memory/lessons/approved.md
 */

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

const MEM = ".harness/memory";

function slug(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
}

function yamlList(xs: string[]): string {
  return `[${xs.map((x) => JSON.stringify(x)).join(", ")}]`;
}

export function writeEpisode(repoDir: string, e: Episode, kind: "episodes" | "incidents" = "episodes"): string {
  const dir = join(repoDir, MEM, kind);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${e.date.slice(0, 10)}-${slug(e.ticketId)}.md`);
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

/**
 * Búsqueda simple por texto (BM25-lite). Con cientos de tickets alcanza;
 * cuando deje de alcanzar, cambiá esta función por embeddings sin tocar el resto.
 */
export function searchMemory(
  repoDir: string,
  query: string,
  opts: { module?: string; limit?: number; existingFiles?: (f: string) => boolean } = {},
): SearchHit[] {
  const q = tokens(query);
  if (q.length === 0) return [];
  const docs: { path: string; text: string }[] = [];
  for (const kind of ["episodes", "incidents"]) {
    const dir = join(repoDir, MEM, kind);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) if (f.endsWith(".md")) docs.push({ path: join(MEM, kind, f), text: readFileSync(join(dir, f), "utf8") });
  }
  const N = docs.length || 1;
  const df = new Map<string, number>();
  const docTokens = docs.map((d) => {
    const ts = tokens(d.text);
    new Set(ts).forEach((t) => df.set(t, (df.get(t) ?? 0) + 1));
    return ts;
  });

  const hits: SearchHit[] = docs.map((d, i) => {
    const ts = docTokens[i];
    let score = 0;
    for (const t of q) {
      const tf = ts.filter((x) => x === t).length;
      if (tf) score += (tf / (tf + 1.2)) * Math.log(1 + N / (df.get(t) ?? 1));
    }
    if (opts.module && frontmatter(d.text, "modules").includes(opts.module)) score *= 1.5;
    if (d.path.includes("/incidents/")) score *= 1.2;
    const files = (frontmatter(d.text, "files").match(/"([^"]+)"/g) ?? []).map((x) => x.slice(1, -1));
    const stale = opts.existingFiles ? files.length > 0 && files.every((f) => !opts.existingFiles!(f)) : false;
    const body = d.text.split(/^---$/m).slice(2).join("---").trim();
    return {
      path: d.path,
      score: stale ? score * 0.5 : score,
      ticket: frontmatter(d.text, "ticket"),
      title: frontmatter(d.text, "title"),
      excerpt: body.slice(0, 700),
      stale,
    };
  });

  return hits
    .filter((h) => h.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 3);
}

export function proposeLesson(repoDir: string, lesson: { title: string; rule: string; evidence: string; module?: string; ticketId?: string }): string {
  const dir = join(repoDir, MEM, "lessons", "pending");
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

> Pendiente de aprobación humana. Para aprobarla, movela a lessons/approved.md en un PR.
`,
  );
  return file;
}

export function approvedLessons(repoDir: string, module?: string): string {
  const p = join(repoDir, MEM, "lessons", "approved.md");
  if (!existsSync(p)) return "No hay lecciones aprobadas todavía.";
  const text = readFileSync(p, "utf8");
  if (!module) return text;
  const sections = text.split(/^## /m);
  const relevant = sections.filter((s, i) => i === 0 || s.toLowerCase().includes(module.toLowerCase()) || /^general/i.test(s));
  return relevant.map((s, i) => (i === 0 ? s : `## ${s}`)).join("");
}
