import { appendJournal, loadState, saveState, type TicketState } from "../memory/state.js";
import { writeEpisode } from "../memory/episodes.js";
import { loadConfig, type HarnessConfig } from "./config.js";
import { runSteps, summarize } from "./exec.js";
import { changedFiles, diffHash, headSha } from "./git.js";
import { laneRequiresGate } from "./lane-policy.js";
import { assessRisk } from "./risk.js";
import { planTests } from "./test-planner.js";
import type { GateResult, Lane, StepResult, TestPlan } from "./types.js";

export interface EpisodeSummary {
  symptom: string;
  rootCause: string;
  fix: string;
  notWorked?: string;
}

function requireTicket(repoDir: string, ticketId: string): TicketState {
  const s = loadState(repoDir, ticketId);
  if (!s) throw new Error(`No existe el ticket ${ticketId}. Llamá a start_ticket.`);
  if (!s.lane) throw new Error(`El ticket ${ticketId} no tiene carril. Llamá a select_lane.`);
  return s;
}

export function changeLane(repoDir: string, s: TicketState, lane: Lane, reason: string): void {
  s.lane = lane;
  s.laneHistory.push({ lane, reason, at: new Date().toISOString() });
  s.gatePassed = undefined;
  saveState(repoDir, s);
  appendJournal(repoDir, s.ticketId, { kind: "escalation", text: `Carril → ${lane}: ${reason}` });
}

export function currentPlan(repoDir: string, ticketId: string): { plan: TestPlan; files: string[]; cfg: HarnessConfig } {
  const cfg = loadConfig(repoDir);
  const s = requireTicket(repoDir, ticketId);
  const files = changedFiles(repoDir, cfg.baseBranch);
  const risk = assessRisk(files, s.lane!, cfg);
  return { plan: planTests(files, s.lane!, cfg, risk), files, cfg };
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
 * GATE FINAL (evaluator determinístico). Corre una vez antes del PR.
 * 1. Revalida el riesgo con el diff real (puede re-carrilar).
 * 2. Planea los tests (test impact analysis) y los corre con presupuesto.
 * 3. Cuenta intentos; al máximo, escala a humano.
 * 4. Si pasa, registra el hash del diff (el hook Stop lo exige) y escribe el episodio.
 */
export async function runGate(repoDir: string, ticketId: string, summary: EpisodeSummary): Promise<GateResult> {
  const cfg = loadConfig(repoDir);
  const s = requireTicket(repoDir, ticketId);
  const max = cfg.gate.maxAttempts;
  const hash = diffHash(repoDir, cfg.baseBranch);
  const base = { maxAttempts: max, diffHash: hash, results: [] as StepResult[] };

  if (!laneRequiresGate(s.lane!)) {
    return { ...base, passed: true, escalated: false, attempt: s.gateAttempts, message: `El carril ${s.lane} no requiere gate.` };
  }
  if (s.status === "escalated") {
    return { ...base, passed: false, escalated: true, attempt: s.gateAttempts, message: "El ticket ya fue escalado a un humano. No sigas intentando." };
  }

  const files = changedFiles(repoDir, cfg.baseBranch).filter((f) => !f.startsWith(".harness/memory/"));
  if (files.length === 0) {
    return { ...base, passed: false, escalated: false, attempt: s.gateAttempts, message: "No hay cambios respecto de la rama base." };
  }

  const risk = assessRisk(files, s.lane!, cfg);
  if (risk.mustEscalate && risk.escalateTo) {
    changeLane(repoDir, s, risk.escalateTo, risk.reason);
    return {
      ...base,
      passed: false,
      escalated: false,
      attempt: s.gateAttempts,
      message: `RE-CARRIL: ${risk.reason}\nSeguí la skill lane-full-feature desde el paso de spec (necesita aprobación humana) antes de volver a correr el gate.`,
    };
  }

  const plan = planTests(files, s.lane!, cfg, risk);
  s.gateAttempts += 1;
  saveState(repoDir, s);

  const results = await runSteps(plan.gate, repoDir, plan.budgetMinutes);
  const passed = results.length === plan.gate.length && results.every((r) => r.ok);
  const timedOut = results.some((r) => r.timedOut);
  const report = summarize(results);

  appendJournal(repoDir, ticketId, { kind: "gate", text: `Intento ${s.gateAttempts}/${max}: ${passed ? "PASÓ" : "FALLÓ"}` });

  if (passed) {
    s.gatePassed = { diffHash: hash, at: new Date().toISOString() };
    s.status = "gate-passed";
    s.summary = summary.fix;
    saveState(repoDir, s);
    const episode = writeEpisode(repoDir, {
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
    }, s.lane === "hotfix" ? "incidents" : "episodes");
    return {
      ...base,
      results,
      passed: true,
      escalated: false,
      attempt: s.gateAttempts,
      message: `GATE OK.\n${report}\n\nEpisodio guardado en ${episode.replace(repoDir + "/", "")}: incluilo en el commit del PR.${plan.notes.length ? "\nNotas: " + plan.notes.join(" ") : ""}`,
    };
  }

  if (s.gateAttempts >= max) {
    s.status = "escalated";
    saveState(repoDir, s);
    appendJournal(repoDir, ticketId, { kind: "escalation", text: `Gate falló ${max} veces: escalado a humano.` });
    return {
      ...base,
      results,
      passed: false,
      escalated: true,
      attempt: s.gateAttempts,
      message: `GATE FALLÓ (${s.gateAttempts}/${max}). Se escala a un humano: dejá un resumen de lo que probaste y frená.\n\n${report}`,
    };
  }

  const hint = timedOut
    ? "\nSe agotó el presupuesto de tiempo del carril: puede que el ticket esté mal clasificado. Si el cambio es más grande de lo esperado, decilo en el resumen."
    : "";
  return {
    ...base,
    results,
    passed: false,
    escalated: false,
    attempt: s.gateAttempts,
    message: `GATE FALLÓ (intento ${s.gateAttempts}/${max}). Corregí y volvé a llamar run_gate.${hint}\n\n${report}`,
  };
}

/** Para el hook Stop: ¿el gate pasó para el diff ACTUAL? */
export function gateStatusForStop(repoDir: string, ticketId: string): { mustBlock: boolean; reason: string; state?: TicketState } {
  const s = loadState(repoDir, ticketId);
  if (!s || !s.lane) return { mustBlock: false, reason: "Ticket sin estado o sin carril." };
  if (!laneRequiresGate(s.lane) || s.status === "escalated" || s.status === "answered" || s.status === "closed") {
    return { mustBlock: false, reason: `Estado ${s.status}, carril ${s.lane}.`, state: s };
  }
  const cfg = loadConfig(repoDir);
  const files = changedFiles(repoDir, cfg.baseBranch).filter((f) => !f.startsWith(".harness/memory/"));
  if (files.length === 0) return { mustBlock: false, reason: "Sin cambios.", state: s };
  const hash = diffHash(repoDir, cfg.baseBranch);
  if (s.gatePassed?.diffHash === hash) return { mustBlock: false, reason: "Gate OK para este diff.", state: s };
  const why = s.gatePassed
    ? "El código cambió después de que pasó el gate."
    : "Todavía no pasó el gate.";
  return { mustBlock: true, reason: why, state: s };
}
