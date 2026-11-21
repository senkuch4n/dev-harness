import { relative } from "node:path";
import type { HarnessConfig, ScopedCommandT } from "./config.js";
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

/** Salida de `specs-afectados.mjs --json` (Evidentia) u otro script con el mismo formato. */
export interface SpecsAfectados {
  suiteCompleta: boolean;
  motivosSuiteCompleta: string[];
  e2e: { spec: string; nombre: string; motivos: string[] }[];
  jest: string[];
  nodeTestClient: string[];
  /** Lista de tests del harness e2e, o `true` si hay que correrlos todos. */
  nodeTestHarness?: boolean | string[];
}

/** Test impact analysis (modo autónomo): archivos → flujos e2e que los cubren. */
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

export function shellQuote(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Comandos con alcance: solo corren si el diff toca sus rutas, y reciben esos archivos. */
function scopedSteps(
  level: TestStep["level"],
  list: ScopedCommandT[],
  files: string[],
  reason: string,
  onlyCode: boolean,
): TestStep[] {
  const steps: TestStep[] = [];
  list.forEach((sc, i) => {
    const hit = files.filter((f) => matchesAny(f, sc.paths) && (!onlyCode || CODE_EXT.test(f)));
    if (hit.length === 0) return;
    const rel = sc.relativeFiles ? hit.map((f) => relative(sc.cwd, f) || f) : hit;
    const cmd = sc.command.replace("{files}", rel.map(shellQuote).join(" "));
    steps.push({
      id: `${level}-${i}`,
      level,
      command: sc.cwd === "." ? cmd : `cd ${shellQuote(sc.cwd)} && ${cmd}`,
      reason: `${reason} (${sc.cwd === "." ? "" : sc.cwd + ", "}${hit.length} archivo/s)`,
    });
  });
  return steps;
}

/** build / lint / typecheck: un comando global o uno por lado tocado. */
function stepsFor(
  level: "build" | "lint" | "typecheck",
  value: string | ScopedCommandT[] | undefined,
  files: string[],
  reason: string,
): TestStep[] {
  if (!value) return [];
  if (typeof value === "string") return [{ id: level, level, command: value, reason }];
  return scopedSteps(level, value, files, reason, false);
}

function e2eStep(flows: string[], cfg: HarnessConfig, reason: string): TestStep[] {
  if (!cfg.commands.e2e || flows.length === 0) return [];
  const grep = e2eGrep(flows, cfg);
  return [{ id: "e2e", level: "e2e", command: cfg.commands.e2e.replace("{grep}", shellQuote(grep)), reason: `${reason}: ${flows.join(", ")}` }];
}

function base(lane: Lane, cfg: HarnessConfig) {
  return {
    lane,
    deferred: ["Suite e2e completa (nightly, post-deploy o revisión por lote)"],
    budgetMinutes: cfg.budgets[lane]?.gateMinutes ?? DEFAULT_BUDGETS[lane] ?? 30,
  };
}

/**
 * Decide QUÉ tests corren en cada etapa según carril + diff.
 * - inner: loop barato, en cada iteración del agente (segundos/minutos).
 * - gate:  una sola vez antes del PR/MR, solo lo relevante.
 * - deferred: suite completa, no bloquea.
 * Con `impact` (salida del script del repo) usa ese análisis en vez del mapa por carpetas.
 */
export function planTests(
  files: string[],
  lane: Lane,
  cfg: HarnessConfig,
  risk?: RiskAssessment,
  impact?: SpecsAfectados,
): TestPlan {
  if (impact) return planFromImpact(files, lane, cfg, impact, risk);

  const c = cfg.commands;
  const affectedFlows = flowsFor(files, cfg);
  const extraFlows = risk?.extraFlows ?? [];
  const notes: string[] = [];
  const onlyDocs = files.length > 0 && files.every((f) => /\.(md|mdx|txt)$/i.test(f) || f.startsWith("docs/"));

  const build = stepsFor("build", c.build, files, "Compila");
  const lint = stepsFor("lint", c.lint, files, "Linter");
  const typecheck = stepsFor("typecheck", c.typecheck, files, "Tipos");
  const unit = scopedSteps("unit", c.unit, files, "Unit de archivos afectados", true);
  const integration = scopedSteps("integration", c.integration, files, "Integración del módulo", true);

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
        ...(c.visual ? [{ id: "visual", level: "visual" as const, command: c.visual, reason: "Regresión visual" }] : []),
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
  return { ...base(lane, cfg), inner: dedupe(inner), gate: dedupe(gate), notes, pendingForReview: [], fullSuiteRecommended: false };
}

/** Plan a partir del análisis de impacto del propio repo (p. ej. specs-afectados.mjs). */
function planFromImpact(files: string[], lane: Lane, cfg: HarnessConfig, impact: SpecsAfectados, risk?: RiskAssessment): TestPlan {
  const c = cfg.commands;
  const t = cfg.adapters.testPlan!;
  const notes: string[] = [];
  const pending: string[] = [];

  const lint = stepsFor("lint", c.lint, files, "Linter");
  const typecheck = stepsFor("typecheck", c.typecheck, files, "Tipos");
  const jest: TestStep[] =
    t.jest && impact.jest.length
      ? [{ id: "jest", level: "unit", command: t.jest.replace("{patterns}", impact.jest.map(shellQuote).join(" ")), reason: `Jest afectados (${impact.jest.length} patrón/es)` }]
      : [];
  const nodeClient: TestStep[] =
    t.nodeTestClient && impact.nodeTestClient.length
      ? [{ id: "node-client", level: "unit", command: t.nodeTestClient.replace("{files}", impact.nodeTestClient.map(shellQuote).join(" ")), reason: `node --test del client (${impact.nodeTestClient.length})` }]
      : [];
  const harness = impact.nodeTestHarness;
  const harnessList = Array.isArray(harness) ? harness : [];
  const nodeHarness: TestStep[] =
    t.nodeTestHarness && (harness === true || harnessList.length)
      ? [{ id: "node-harness", level: "unit", command: t.nodeTestHarness.replace("{files}", harnessList.map(shellQuote).join(" ")), reason: "node --test del harness e2e" }]
      : [];

  let e2e: TestStep[] = [];
  if (impact.e2e.length) {
    if (c.e2eSpecs) {
      e2e = [{ id: "e2e", level: "e2e", command: c.e2eSpecs.replace("{specs}", impact.e2e.map((s) => shellQuote(s.spec)).join(" ")), reason: `E2E afectados (${impact.e2e.length})` }];
    } else {
      pending.push(`E2E afectados (${impact.e2e.length}): ${impact.e2e.map((s) => s.nombre).join(", ")}`);
    }
  }
  if (impact.suiteCompleta) {
    pending.push(`SUITE COMPLETA RECOMENDADA: ${impact.motivosSuiteCompleta.join("; ")}`);
  }

  let inner: TestStep[] = [];
  let gate: TestStep[] = [];
  switch (lane) {
    case "hotfix":
      inner = [...jest];
      gate = [...typecheck, ...jest, ...nodeClient, ...e2e];
      notes.push("Hotfix: la suite e2e completa corre después del deploy, no bloquea el fix.");
      break;
    case "fast-feature":
      inner = [...typecheck, ...nodeClient];
      gate = [...lint, ...typecheck, ...jest, ...nodeClient, ...nodeHarness, ...e2e];
      break;
    case "chore":
      inner = [...lint];
      gate = [...lint, ...typecheck, ...jest, ...nodeClient, ...nodeHarness];
      break;
    case "query":
    case "human-triage":
      notes.push("Este carril no produce código: no hay gate.");
      break;
    default:
      inner = [...typecheck, ...jest];
      gate = [...lint, ...typecheck, ...jest, ...nodeClient, ...nodeHarness, ...e2e];
  }
  if (risk && risk.level === "high") notes.push(risk.reason);
  return {
    ...base(lane, cfg),
    inner: dedupe(inner),
    gate: dedupe(gate),
    notes,
    pendingForReview: pending,
    fullSuiteRecommended: impact.suiteCompleta,
  };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function dedupe(steps: TestStep[]): TestStep[] {
  const seen = new Set<string>();
  return steps.filter((s) => (seen.has(s.command) ? false : (seen.add(s.command), true)));
}
