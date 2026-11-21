import { relative } from "node:path";
import type { HarnessConfig } from "./config.js";
import { matchesAny } from "./risk.js";
import type { Lane, RiskAssessment, TestPlan, TestStep } from "./types.js";

const DEFAULT_BUDGETS: Record<string, number> = {
  hotfix: 15,
  bugfix: 25,
  "fast-feature": 10,
  "full-feature": 45,
  chore: 10,
};

const CODE_EXT = /\.(c|m)?(t|j)sx?$/;

/** Test impact analysis: archivos → flujos e2e que los cubren. */
export function flowsFor(files: string[], cfg: HarnessConfig): string[] {
  const flows = new Set<string>();
  for (const [glob, fl] of Object.entries(cfg.testImpact)) {
    if (files.some((f) => matchesAny(f, [glob]))) fl.forEach((x) => flows.add(x));
  }
  return [...flows].sort();
}

function e2eGrep(flows: string[], cfg: HarnessConfig): string {
  return flows.map((f) => cfg.e2eTagFormat.replace("{flow}", f)).join("|");
}

function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Resuelve comandos con alcance (unit / integration) solo para los archivos afectados. */
function scopedSteps(
  level: "unit" | "integration",
  files: string[],
  cfg: HarnessConfig,
  reason: string,
): TestStep[] {
  const steps: TestStep[] = [];
  cfg.commands[level].forEach((sc, i) => {
    const hit = files.filter((f) => matchesAny(f, sc.paths) && CODE_EXT.test(f));
    if (hit.length === 0) return;
    const rel = sc.relativeFiles ? hit.map((f) => relative(sc.cwd, f) || f) : hit;
    const cmd = sc.command.replace("{files}", rel.map(shellQuote).join(" "));
    steps.push({
      id: `${level}-${i}`,
      level,
      command: sc.cwd === "." ? cmd : `cd ${shellQuote(sc.cwd)} && ${cmd}`,
      reason: `${reason} (${hit.length} archivo/s)`,
    });
  });
  return steps;
}

function simple(id: string, level: TestStep["level"], command: string | undefined, reason: string): TestStep[] {
  return command ? [{ id, level, command, reason }] : [];
}

function e2eStep(flows: string[], cfg: HarnessConfig, reason: string): TestStep[] {
  if (!cfg.commands.e2e || flows.length === 0) return [];
  const grep = e2eGrep(flows, cfg);
  return [
    {
      id: "e2e",
      level: "e2e",
      command: cfg.commands.e2e.replace("{grep}", shellQuote(grep)),
      reason: `${reason}: ${flows.join(", ")}`,
    },
  ];
}

/**
 * Decide QUÉ tests corren en cada etapa según carril + diff.
 * - inner: loop barato, en cada iteración del agente (segundos/minutos).
 * - gate:  una sola vez antes del PR, solo lo relevante.
 * - deferred: suite completa, no bloquea (nightly / post-deploy).
 */
export function planTests(files: string[], lane: Lane, cfg: HarnessConfig, risk?: RiskAssessment): TestPlan {
  const c = cfg.commands;
  const affectedFlows = flowsFor(files, cfg);
  const extraFlows = risk?.extraFlows ?? [];
  const notes: string[] = [];
  const onlyDocs = files.length > 0 && files.every((f) => /\.(md|mdx|txt)$/i.test(f) || f.startsWith("docs/"));

  const build = simple("build", "build", c.build, "Compila");
  const lint = simple("lint", "lint", c.lint, "Linter");
  const typecheck = simple("typecheck", "typecheck", c.typecheck, "Tipos");
  const unit = scopedSteps("unit", files, cfg, "Unit de archivos afectados");
  const integration = scopedSteps("integration", files, cfg, "Integración del módulo");

  let inner: TestStep[] = [];
  let gate: TestStep[] = [];

  switch (lane) {
    case "hotfix":
      inner = [...unit];
      gate = [...typecheck, ...unit, ...e2eStep(cfg.criticalFlows, cfg, "Smoke de flujos críticos")];
      notes.push("Hotfix: la suite e2e completa corre post-deploy, no bloquea el fix.");
      break;

    case "bugfix":
      inner = [...unit];
      gate = [...lint, ...typecheck, ...unit, ...integration, ...e2eStep(uniq([...affectedFlows, ...extraFlows]), cfg, "E2E del flujo afectado")];
      break;

    case "fast-feature":
      inner = [...typecheck, ...unit];
      gate = [
        ...lint,
        ...typecheck,
        ...unit,
        ...simple("visual", "visual", c.visual, "Regresión visual"),
        ...e2eStep(uniq([...affectedFlows, ...extraFlows]), cfg, "Smoke de las pantallas afectadas"),
      ];
      break;

    case "full-feature":
      inner = [...typecheck, ...unit, ...integration];
      gate = [...build, ...lint, ...typecheck, ...unit, ...integration, ...e2eStep(uniq([...affectedFlows, ...extraFlows]), cfg, "E2E de los flujos tocados")];
      break;

    case "chore":
      inner = onlyDocs ? [] : [...lint];
      gate = onlyDocs ? [] : [...build, ...lint, ...typecheck, ...unit];
      if (files.some((f) => /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(f))) {
        notes.push("Cambiaron dependencias: la suite completa corre en el nightly.");
      }
      break;

    case "query":
    case "human-triage":
      notes.push("Este carril no produce código: no hay gate.");
      break;
  }

  if (risk?.extraFlows.length) notes.push(risk.reason);
  if (gate.some((s) => s.level === "e2e" || s.level === "integration") && c.servicesUp) {
    gate.unshift({ id: "services", level: "integration", command: c.servicesUp, reason: "Levanta servicios para tests (Postgres, Redis)" });
  }

  return {
    lane,
    inner: dedupe(inner),
    gate: dedupe(gate),
    deferred: ["Suite e2e completa (nightly o post-deploy)"],
    budgetMinutes: cfg.budgets[lane]?.gateMinutes ?? DEFAULT_BUDGETS[lane] ?? 30,
    notes,
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function dedupe(steps: TestStep[]): TestStep[] {
  const seen = new Set<string>();
  return steps.filter((s) => (seen.has(s.command) ? false : (seen.add(s.command), true)));
}
