import { execSync } from "node:child_process";
import { appendJournal, loadState, saveState, type TicketState } from "../memory/state.js";
import { writeEpisode } from "../memory/episodes.js";
import { baseRev, fill, mergeBase } from "./base.js";
import { loadConfig, type HarnessConfig } from "./config.js";
import { runSteps, summarize } from "./exec.js";
import { changedFiles, diffHash, headSha, uncommitted } from "./git.js";
import { laneRequiresGate } from "./lane-policy.js";
import { assessRiskFor, matchesAny } from "./risk.js";
import { planTests, type SpecsAfectados } from "./test-planner.js";
import type { GateResult, Lane, RiskAssessment, StepResult, TestPlan } from "./types.js";

export interface EpisodeSummary {
  symptom: string;
  rootCause: string;
  fix: string;
  notWorked?: string;
}

/** Archivos que escribe el propio arnés y no cuentan como "cambio del ticket". */
export function harnessOwnPrefixes(cfg: HarnessConfig): string[] {
  return [".harness/run/", ".harness/memory/", `${cfg.memory.episodesDir}/${cfg.memory.filePrefix}`, `${cfg.memory.incidentsDir}/${cfg.memory.filePrefix}`, cfg.memory.pendingLessonsDir + "/"];
}

/** ¿Es un archivo propio del arnés o basura suelta (patches, .DS_Store) que no es parte del ticket? */
export function isNoise(f: string, cfg: HarnessConfig): boolean {
  return harnessOwnPrefixes(cfg).some((p) => f.startsWith(p)) || matchesAny(f, cfg.gate.ignoreFiles);
}

function ticketFiles(repoDir: string, cfg: HarnessConfig, lane?: Lane, override?: string): string[] {
  return changedFiles(repoDir, baseRev(repoDir, cfg, lane, override)).filter((f) => !isNoise(f, cfg));
}

function requireTicket(repoDir: string, ticketId: string): TicketState {
  const s = loadState(repoDir, ticketId);
  if (!s) throw new Error(`No existe el ticket ${ticketId}. Llamá a start_ticket.`);
  if (!s.lane) throw new Error(`El ticket ${ticketId} no tiene carril. Llamá a select_lane.`);
  return s;
}

export function changeLane(repoDir: string, s: TicketState, lane: Lane, reason: string, cfg: HarnessConfig): void {
  s.lane = lane;
  s.laneHistory.push({ lane, reason, at: new Date().toISOString() });
  s.gatePassed = undefined;
  if (cfg.lanes.delegate[lane]) s.status = "delegated";
  saveState(repoDir, s);
  appendJournal(repoDir, s.ticketId, { kind: "escalation", text: `Carril → ${lane}: ${reason}` });
}

/** Corre el script de análisis de impacto del repo (si hay adaptador). */
export function runImpact(repoDir: string, cfg: HarnessConfig, lane?: Lane, override?: string): SpecsAfectados | undefined {
  const t = cfg.adapters.testPlan;
  if (!t) return undefined;
  const cmd = fill(t.command, { base: baseRev(repoDir, cfg, lane, override), mergeBase: mergeBase(repoDir, cfg, lane, override) });
  const out = execSync(cmd, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, shell: "/bin/bash" });
  const start = out.indexOf("{");
  if (start < 0) throw new Error(`El análisis de impacto no devolvió JSON:\n${out.slice(0, 500)}`);
  return JSON.parse(out.slice(start)) as SpecsAfectados;
}

export function currentPlan(repoDir: string, ticketId: string): { plan: TestPlan; files: string[]; risk: RiskAssessment; cfg: HarnessConfig } {
  const cfg = loadConfig(repoDir);
  const s = requireTicket(repoDir, ticketId);
  const files = ticketFiles(repoDir, cfg, s.lane, s.baseOverride);
  const risk = assessRiskFor(repoDir, files, s.lane!, cfg, s.baseOverride);
  const impact = files.length ? runImpactSafe(repoDir, cfg, s.lane, s.baseOverride) : undefined;
  return { plan: planTests(files, s.lane!, cfg, risk, impact), files, risk, cfg };
}

function runImpactSafe(repoDir: string, cfg: HarnessConfig, lane?: Lane, override?: string): SpecsAfectados | undefined {
  try {
    return runImpact(repoDir, cfg, lane, override);
  } catch {
    return undefined;
  }
}

/** Loop interno: barato, se puede llamar en cada iteración. */
export async function runInner(repoDir: string, ticketId: string): Promise<{ ok: boolean; report: string }> {
  const { plan } = currentPlan(repoDir, ticketId);
  if (plan.inner.length === 0) return { ok: true, report: "No hay chequeos internos para este carril/diff." };
  const results = await runSteps(plan.inner, repoDir, Math.max(5, Math.ceil(plan.budgetMinutes / 2)));
  const ok = results.every((r) => r.ok) && results.length === plan.inner.length;
  return { ok, report: summarize(results) };
}

/**
 * GATE FINAL (evaluator determinístico). Corre una vez antes del PR/MR.
 * 1. Revalida el riesgo con el diff real (puede re-carrilar o delegar al flujo del repo).
 * 2. Planea los tests (análisis de impacto) y los corre con presupuesto.
 * 3. Cuenta intentos; al máximo, escala a humano.
 * 4. Si pasa, registra el hash del diff (el hook Stop lo exige) y escribe el episodio.
 */
export async function runGate(repoDir: string, ticketId: string, summary: EpisodeSummary): Promise<GateResult> {
  const cfg = loadConfig(repoDir);
  const s = requireTicket(repoDir, ticketId);
  const max = cfg.gate.maxAttempts;
  const hash = hashFor(repoDir, cfg, s.lane, s.baseOverride);
  const base = { maxAttempts: max, diffHash: hash, results: [] as StepResult[] };
  const fail = (message: string, extra: Partial<GateResult> = {}): GateResult => ({ ...base, passed: false, escalated: false, attempt: s.gateAttempts, message, ...extra });

  if (!laneRequiresGate(s.lane!) || s.status === "delegated") {
    return { ...base, passed: true, escalated: false, attempt: s.gateAttempts, message: `El carril ${s.lane} no pasa por este gate.` };
  }
  if (s.status === "escalated") return fail("El ticket ya fue escalado a un humano. No sigas intentando.", { escalated: true });

  const files = ticketFiles(repoDir, cfg, s.lane, s.baseOverride);
  if (files.length === 0) return fail(`No hay cambios respecto de la rama base (${baseRev(repoDir, cfg, s.lane, s.baseOverride)}).`);

  if (cfg.adapters.testPlan && cfg.gate.requireCommitted) {
    const dirty = uncommitted(repoDir).filter((f) => !isNoise(f, cfg));
    if (dirty.length) return fail(`El análisis de impacto del repo mira commits: commiteá el trabajo antes del gate (aunque sea un commit WIP). Sin commitear: ${dirty.slice(0, 10).join(", ")}`);
  }

  const risk = assessRiskFor(repoDir, files, s.lane!, cfg, s.baseOverride);
  let impact: SpecsAfectados | undefined;
  try {
    impact = runImpact(repoDir, cfg, s.lane, s.baseOverride);
  } catch (e) {
    return fail(`Falló el análisis de impacto del repo: ${(e as Error).message}`);
  }

  // Solo el RIESGO re-carrila. Que el cambio sea global (p. ej. un componente del layout) dice
  // cuántos tests correr, no cuánto proceso necesita: eso queda como "suite completa en el lote".
  if (risk.mustEscalate) {
    changeLane(repoDir, s, "full-feature", risk.reason, cfg);
    const delegated = cfg.lanes.delegate["full-feature"];
    return fail(
      delegated
        ? `RE-CARRIL: ${risk.reason}\nEl ticket pasa al flujo "${delegated}" del repo (ver CLAUDE.md/AGENTS.md). Este gate ya no aplica.`
        : `RE-CARRIL: ${risk.reason}\nSeguí la skill lane-full-feature desde el paso de spec (necesita aprobación humana) antes de volver a correr el gate.`,
    );
  }

  const plan = planTests(files, s.lane!, cfg, risk, impact);
  s.gateAttempts += 1;
  saveState(repoDir, s);

  const results = await runSteps(plan.gate, repoDir, plan.budgetMinutes);
  const passed = results.length === plan.gate.length && results.every((r) => r.ok);
  const timedOut = results.some((r) => r.timedOut);
  const report = summarize(results) || "(no hubo pasos que correr para este diff)";
  const pending = plan.pendingForReview.length ? `\n\nPENDIENTE PARA EL REVISOR / LOTE (el gate no lo corre):\n- ${plan.pendingForReview.join("\n- ")}` : "";
  const riskLine = `\nRiesgo: ${risk.level}${risk.level === "high" && cfg.guard.humanOkForHighRiskPush ? " → el push necesita OK humano (record_human_ok)" : ""}.`;

  appendJournal(repoDir, ticketId, { kind: "gate", text: `Intento ${s.gateAttempts}/${max}: ${passed ? "PASÓ" : "FALLÓ"} (riesgo ${risk.level})` });

  if (passed) {
    s.gatePassed = { diffHash: hash, at: new Date().toISOString() };
    s.status = "gate-passed";
    s.summary = summary.fix;
    s.risk = risk.level;
    saveState(repoDir, s);
    const episode = writeEpisode(
      repoDir,
      {
        ticketId,
        title: s.title,
        lane: s.laneHistory[0]?.lane ?? s.lane!,
        finalLane: s.lane!,
        outcome: "merged-pending-review",
        modules: s.triage?.modules ?? [],
        files,
        commit: headSha(repoDir),
        attempts: s.gateAttempts,
        symptom: summary.symptom,
        rootCause: summary.rootCause,
        fix: summary.fix,
        notWorked: summary.notWorked ?? "",
        date: new Date().toISOString(),
      },
      s.lane === "hotfix" ? "incidents" : "episodes",
      cfg,
    );
    return {
      ...base,
      results,
      passed: true,
      escalated: false,
      attempt: s.gateAttempts,
      message: `GATE OK.\n${report}${riskLine}${pending}\n\nEpisodio guardado en ${episode.replace(repoDir + "/", "")}: incluilo en el commit.${plan.notes.length ? "\nNotas: " + plan.notes.join(" ") : ""}`,
    };
  }

  if (s.gateAttempts >= max) {
    s.status = "escalated";
    saveState(repoDir, s);
    appendJournal(repoDir, ticketId, { kind: "escalation", text: `Gate falló ${max} veces: escalado a humano.` });
    return { ...base, results, passed: false, escalated: true, attempt: s.gateAttempts, message: `GATE FALLÓ (${s.gateAttempts}/${max}). Se escala a un humano: dejá un resumen de lo que probaste y frená.\n\n${report}` };
  }

  const hint = timedOut
    ? "\nSe agotó el presupuesto de tiempo del carril: puede que el ticket esté mal clasificado. Si el cambio es más grande de lo esperado, decilo en el resumen."
    : "";
  return { ...base, results, passed: false, escalated: false, attempt: s.gateAttempts, message: `GATE FALLÓ (intento ${s.gateAttempts}/${max}). Corregí y volvé a llamar run_gate.${hint}\n\n${report}` };
}

/** Para el hook Stop: ¿el gate pasó para el diff ACTUAL? */
export function gateStatusForStop(repoDir: string, ticketId: string): { mustBlock: boolean; reason: string; state?: TicketState } {
  const s = loadState(repoDir, ticketId);
  if (!s || !s.lane) return { mustBlock: false, reason: "Ticket sin estado o sin carril." };
  if (s.status === "waiting-user") return { mustBlock: false, reason: `Esperando al usuario: ${s.waitingFor ?? ""}`, state: s };
  if (!laneRequiresGate(s.lane) || ["escalated", "answered", "closed", "delegated"].includes(s.status)) {
    return { mustBlock: false, reason: `Estado ${s.status}, carril ${s.lane}.`, state: s };
  }
  const cfg = loadConfig(repoDir);
  const files = ticketFiles(repoDir, cfg, s.lane, s.baseOverride);
  if (files.length === 0) return { mustBlock: false, reason: "Sin cambios.", state: s };
  const hash = hashFor(repoDir, cfg, s.lane, s.baseOverride);
  if (s.gatePassed?.diffHash === hash) return { mustBlock: false, reason: "Gate OK para este diff.", state: s };
  const why = s.gatePassed ? "El código cambió después de que pasó el gate." : "Todavía no pasó el gate.";
  return { mustBlock: true, reason: why, state: s };
}

function hashFor(repoDir: string, cfg: HarnessConfig, lane?: Lane, override?: string): string {
  const files = ticketFiles(repoDir, cfg, lane, override);
  return diffHash(repoDir, baseRev(repoDir, cfg, lane, override), [], files);
}
