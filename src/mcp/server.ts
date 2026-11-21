#!/usr/bin/env node
/**
 * Servidor MCP del arnés: acá vive el patrón TOOL USE.
 * Claude Code (dentro de Orca) lo levanta por stdio; las tools aparecen como
 * mcp__plugin_dev-harness_harness__<nombre> (o mcp__harness__<nombre> si lo registrás a mano).
 *
 * Regla de diseño: las tools hacen lo determinístico. El LLM decide QUÉ pedir;
 * el código decide CÓMO se hace y qué está permitido.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { agentMap, hasConfig, loadConfig } from "../core/config.js";
import { runStep } from "../core/exec.js";
import { currentPlan, isNoise, runGate, runInner } from "../core/gate.js";
import { baseRev } from "../core/base.js";
import { changedFiles, headSha } from "../core/git.js";
import { writeHumanOk } from "../core/human-ok.js";
import { selectLane } from "../core/lane-policy.js";
import { assessRiskFor } from "../core/risk.js";
import { approvedLessons, proposeLesson, searchMemory } from "../memory/episodes.js";
import {
  appendJournal,
  createState,
  getActiveTicket,
  loadState,
  readJournal,
  setActiveTicket,
  updateState,
} from "../memory/state.js";

const repoDir = process.env.DEV_HARNESS_REPO || process.cwd();

const server = new McpServer({ name: "harness", version: "0.2.1" });

type Content = { content: { type: "text"; text: string }[]; isError?: boolean };

function text(t: string, isError = false): Content {
  return { content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) };
}

function json(o: unknown): Content {
  return text(JSON.stringify(o, null, 2));
}

function ticketOrActive(id?: string): string {
  const t = id || getActiveTicket(repoDir);
  if (!t) throw new Error("No hay ticket activo en este worktree. Llamá a start_ticket.");
  return t;
}

function resume(id: string): void {
  if (loadState(repoDir, id)?.status === "waiting-user") updateState(repoDir, id, (st) => (st.status = "open"));
}

/** Envuelve handlers para devolver errores como texto útil al agente. */
function safe<A>(fn: (args: A) => Promise<Content> | Content) {
  return async (args: A): Promise<Content> => {
    try {
      if (!hasConfig(repoDir)) return text("Este repo no tiene .harness/config.json. Usá la skill setup-harness.", true);
      return await fn(args);
    } catch (e) {
      return text(`Error: ${(e as Error).message}`, true);
    }
  };
}

const optionalTicket = { ticketId: z.string().optional().describe("ID del ticket. Si se omite, usa el ticket activo del worktree.") };

// ───────────────────────────── Entrada y triage ─────────────────────────────

server.registerTool(
  "start_ticket",
  {
    description:
      "Registra un ticket (de Linear/GitHub/manual) como activo en este worktree y devuelve tickets parecidos y lecciones de la memoria. Llamalo SIEMPRE primero.",
    inputSchema: {
      ticketId: z.string().describe("Ej: LIN-123 o GH-45"),
      title: z.string(),
      body: z.string().default("").describe("Descripción del ticket, para buscar tickets parecidos"),
      source: z.string().optional().describe("linear | github | gitlab | manual"),
      baseBranch: z
        .string()
        .optional()
        .describe("SOLO si el usuario lo pide: rama base para este ticket (p. ej. cuando el arnés todavía no está integrado en la base habitual)."),
    },
  },
  safe(({ ticketId, title, body, source, baseBranch }) => {
    const cfg = loadConfig(repoDir);
    createState(repoDir, ticketId, title, source);
    let reopened = false;
    const s = updateState(repoDir, ticketId, (st) => {
      if (baseBranch) st.baseOverride = baseBranch;
      if (st.status === "waiting-user") st.status = "open";
      // Volver a pedir el ticket es una decisión del usuario: un escalado se reabre con contadores nuevos.
      if (st.status === "escalated") {
        st.status = "open";
        st.gateAttempts = 0;
        st.stopBlocks = 0;
        reopened = true;
      }
    });
    if (reopened) appendJournal(repoDir, ticketId, { kind: "decision", text: "Reabierto por el usuario (estaba escalado): intentos del gate en 0." });
    if (baseBranch) appendJournal(repoDir, ticketId, { kind: "decision", text: `Base del ticket: ${baseBranch} (pedido del usuario)` });
    setActiveTicket(repoDir, ticketId);
    const similar = searchMemory(repoDir, `${title} ${body}`, { limit: 5, cfg, existingFiles: (f) => existsSync(join(repoDir, f)) });
    return json({
      ticket: { id: s.ticketId, status: s.status, lane: s.lane ?? null, gateAttempts: s.gateAttempts },
      resumed: s.laneHistory.length > 0,
      reopened,
      base: s.baseOverride ?? null,
      agents: agentMap(cfg),
      delegatedLanes: cfg.lanes.delegate,
      similarPastTickets: similar,
      hint:
        similar.length > 0
          ? "Revisá si alguno es duplicado o si su causa raíz aplica. Pasale estos resultados al subagente triage."
          : "No hay tickets parecidos en la memoria.",
    });
  }),
);

server.registerTool(
  "select_lane",
  {
    description:
      "Recibe la clasificación del subagente triage y devuelve el CARRIL. La decisión la toma código determinístico, no el modelo. No elijas el carril vos.",
    inputSchema: {
      ...optionalTicket,
      type: z.enum(["bug", "feature", "question", "chore", "docs"]),
      risk: z.enum(["low", "medium", "high"]),
      urgency: z.enum(["normal", "high", "critical"]),
      modules: z.array(z.string()).default([]),
      confidence: z.number().min(0).max(1),
      rationale: z.string(),
    },
  },
  safe(({ ticketId, ...triage }) => {
    const id = ticketOrActive(ticketId);
    const cfg = loadConfig(repoDir);
    const { lane, reason } = selectLane(triage, cfg.triage.minConfidence);
    const delegatedTo = cfg.lanes.delegate[lane];
    const s = updateState(repoDir, id, (st) => {
      st.triage = triage;
      st.lane = lane;
      st.laneHistory.push({ lane, reason, at: new Date().toISOString() });
      if (delegatedTo) {
        st.status = "delegated";
        st.delegatedTo = delegatedTo;
      }
    });
    appendJournal(repoDir, id, { kind: "decision", text: `Carril ${lane}: ${reason}${delegatedTo ? ` → flujo del repo: ${delegatedTo}` : ""}` });
    return json({
      lane,
      reason,
      delegatedTo: delegatedTo ?? null,
      nextSkill: delegatedTo || lane === "human-triage" ? null : `lane-${lane}`,
      instructions: delegatedTo
        ? `Este carril lo resuelve el flujo propio del repo: "${delegatedTo}". Seguí CLAUDE.md/AGENTS.md del repo; el gate de dev-harness no aplica, pero las guardas sí.`
        : undefined,
      agents: agentMap(cfg),
      ticket: s.ticketId,
    });
  }),
);

// ───────────────────────────── Memoria de trabajo ─────────────────────────────

server.registerTool(
  "get_ticket",
  {
    description: "Estado compartido del ticket: carril, intentos, bitácora (hipótesis, descartes, plan). Leelo al empezar cualquier subtarea.",
    inputSchema: optionalTicket,
  },
  safe(({ ticketId }) => {
    const id = ticketOrActive(ticketId);
    return json({ state: loadState(repoDir, id), journal: readJournal(repoDir, id).slice(-40) });
  }),
);

server.registerTool(
  "update_ticket_state",
  {
    description:
      "Escribe en la memoria compartida del ticket. Usalo para registrar hipótesis, descartes y avances, así otros agentes (en otros worktrees) no repiten trabajo.",
    inputSchema: {
      ...optionalTicket,
      kind: z.enum(["hypothesis", "discarded", "progress", "plan"]),
      text: z.string(),
      agent: z.string().optional().describe("Nombre del subagente que escribe"),
    },
  },
  safe(({ ticketId, kind, text: t, agent }) => {
    const id = ticketOrActive(ticketId);
    appendJournal(repoDir, id, { kind, text: t, agent });
    return text("ok");
  }),
);

// ───────────────────────────── Riesgo y tests ─────────────────────────────

server.registerTool(
  "check_risk",
  {
    description: "Revisa el diff ACTUAL contra las rutas críticas y compartidas. Usalo apenas sepas qué archivos vas a tocar.",
    inputSchema: optionalTicket,
  },
  safe(({ ticketId }) => {
    const id = ticketOrActive(ticketId);
    const cfg = loadConfig(repoDir);
    const s = loadState(repoDir, id);
    const files = changedFiles(repoDir, baseRev(repoDir, cfg, s?.lane, s?.baseOverride)).filter((f) => !isNoise(f, cfg));
    return json({ lane: s?.lane, base: baseRev(repoDir, cfg, s?.lane, s?.baseOverride), files, risk: assessRiskFor(repoDir, files, s?.lane ?? "bugfix", cfg, s?.baseOverride) });
  }),
);

server.registerTool(
  "plan_tests",
  {
    description: "Muestra qué tests correrían en el loop interno y en el gate para el diff actual (test impact analysis). No corre nada.",
    inputSchema: optionalTicket,
  },
  safe(({ ticketId }) => {
    const { plan, risk, files } = currentPlan(repoDir, ticketOrActive(ticketId));
    return json({ files, risk, plan });
  }),
);

server.registerTool(
  "run_checks",
  {
    description:
      "LOOP INTERNO: corre solo los chequeos baratos del carril (tipos, unit de archivos afectados). Usalo en cada iteración. Nunca corre e2e.",
    inputSchema: optionalTicket,
  },
  safe(async ({ ticketId }) => {
    const id = ticketOrActive(ticketId);
    resume(id);
    const r = await runInner(repoDir, id);
    return text(`${r.ok ? "OK" : "FALLÓ"}\n\n${r.report}`, !r.ok);
  }),
);

server.registerTool(
  "run_gate",
  {
    description:
      "GATE FINAL: revalida riesgo, corre los tests relevantes una sola vez y, si pasa, guarda el episodio en la memoria. Llamalo cuando creas que terminaste y ANTES de abrir el PR. El hook Stop no te deja terminar sin un gate OK para el diff actual.",
    inputSchema: {
      ...optionalTicket,
      symptom: z.string().describe("Qué se observaba (para la memoria episódica)"),
      rootCause: z.string().describe("Causa raíz encontrada, o 'n/a' para features"),
      fix: z.string().describe("Qué se cambió y por qué"),
      notWorked: z.string().default("").describe("Hipótesis o enfoques descartados"),
    },
  },
  safe(async ({ ticketId, ...summary }) => {
    const id = ticketOrActive(ticketId);
    resume(id);
    const g = await runGate(repoDir, id, summary);
    return text(g.message, !g.passed);
  }),
);

// ───────────────────────────── Herramientas del sistema ─────────────────────────────

server.registerTool(
  "take_screenshot",
  {
    description: "Saca un screenshot de una URL de la app (la app tiene que estar levantada). Devuelve la ruta del PNG para leerlo con Read.",
    inputSchema: { url: z.string(), name: z.string().regex(/^[\w-]+$/) },
  },
  safe(async ({ url, name }) => {
    const cfg = loadConfig(repoDir);
    if (!cfg.commands.screenshot) return text("No hay commands.screenshot en .harness/config.json.", true);
    const dir = join(repoDir, ".harness/run/screenshots");
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${name}.png`);
    const cmd = cfg.commands.screenshot.replace("{url}", JSON.stringify(url)).replace("{out}", JSON.stringify(out));
    const r = await runStep({ id: "shot", level: "visual", command: cmd, reason: "screenshot" }, repoDir, 120_000);
    return r.ok ? text(`Screenshot: ${out}`) : text(`No se pudo sacar el screenshot:\n${r.output}`, true);
  }),
);

server.registerTool(
  "toggle_flag",
  {
    description: "MITIGACIÓN de hotfix: prende o apaga un feature flag. Solo en carril hotfix y con confirmación humana previa.",
    inputSchema: { ...optionalTicket, flag: z.string().regex(/^[\w.-]+$/), state: z.enum(["on", "off"]), approvedBy: z.string().describe("Quién lo aprobó") },
  },
  safe(async ({ ticketId, flag, state, approvedBy }) => {
    const id = ticketOrActive(ticketId);
    const cfg = loadConfig(repoDir);
    const s = loadState(repoDir, id);
    if (s?.lane !== "hotfix") return text("toggle_flag solo está permitido en el carril hotfix.", true);
    if (!cfg.featureFlags) return text("No hay featureFlags.toggleCommand configurado.", true);
    const cmd = cfg.featureFlags.toggleCommand.replace("{flag}", flag).replace("{state}", state);
    const r = await runStep({ id: "flag", level: "integration", command: cmd, reason: "toggle flag" }, repoDir, 60_000);
    appendJournal(repoDir, id, { kind: "decision", text: `Flag ${flag} → ${state} (aprobó ${approvedBy}): ${r.ok ? "OK" : "FALLÓ"}` });
    return text(r.ok ? `Flag ${flag} = ${state}` : r.output, !r.ok);
  }),
);

// ───────────────────────────── Memoria episódica y procedural ─────────────────────────────

server.registerTool(
  "search_past_tickets",
  {
    description: "Busca tickets resueltos e incidentes parecidos (memoria episódica). Usalo antes de clasificar, investigar un hotfix o diseñar una solución.",
    inputSchema: { query: z.string(), module: z.string().optional(), limit: z.number().int().min(1).max(10).default(3) },
  },
  safe(({ query, module, limit }) =>
    json(searchMemory(repoDir, query, { module, limit, cfg: loadConfig(repoDir), existingFiles: (f) => existsSync(join(repoDir, f)) })),
  ),
);

server.registerTool(
  "get_lessons",
  {
    description: "Lecciones APROBADAS por humanos (reglas aprendidas). Filtrá por módulo.",
    inputSchema: { module: z.string().optional() },
  },
  safe(({ module }) => text(approvedLessons(repoDir, module, loadConfig(repoDir)))),
);

server.registerTool(
  "propose_lesson",
  {
    description:
      "Propone una lección nueva (queda PENDIENTE hasta que un humano la apruebe). Solo para problemas que se repitieron o que costaron caro. Nunca propongas desactivar validaciones o tests.",
    inputSchema: { ...optionalTicket, title: z.string(), rule: z.string(), evidence: z.string(), module: z.string().optional() },
  },
  safe(({ ticketId, ...lesson }) => {
    const file = proposeLesson(repoDir, { ...lesson, ticketId: ticketId || getActiveTicket(repoDir) }, loadConfig(repoDir));
    return text(`Lección pendiente en ${file.replace(repoDir + "/", "")}. Incluila en el PR para que la revise un humano.`);
  }),
);

server.registerTool(
  "pause_ticket",
  {
    description:
      "Pausa el ticket porque necesitás algo del USUARIO (una respuesta, una decisión, una acción en su máquina). Te deja terminar el turno sin pasar el gate y sin cerrar el ticket. Se reanuda solo al volver a llamar start_ticket, run_checks o run_gate.",
    inputSchema: { ...optionalTicket, waitingFor: z.string().describe("Qué necesitás del usuario, concreto") },
  },
  safe(({ ticketId, waitingFor }) => {
    const id = ticketOrActive(ticketId);
    updateState(repoDir, id, (st) => {
      if (st.status === "open" || st.status === "gate-passed") {
        st.status = "waiting-user";
        st.waitingFor = waitingFor;
      }
    });
    appendJournal(repoDir, id, { kind: "progress", text: `Pausa: espera al usuario — ${waitingFor}` });
    return text(`Ticket ${id} en pausa. Explicale al usuario qué necesitás y terminá el turno.`);
  }),
);

server.registerTool(
  "record_human_ok",
  {
    description:
      "Registra el OK EXPLÍCITO del usuario para pushear un cambio de riesgo alto, atado al commit actual (HEAD). Solo llamalo después de que el usuario lo haya dicho en la conversación. Si después cambia el código, hace falta un OK nuevo.",
    inputSchema: {
      approvedBy: z.string().describe("Quién dio el OK"),
      quote: z.string().describe("Lo que dijo el usuario, textual"),
    },
  },
  safe(({ approvedBy, quote }) => {
    const ok = writeHumanOk(repoDir, approvedBy, quote);
    const id = getActiveTicket(repoDir);
    if (id) appendJournal(repoDir, id, { kind: "decision", text: `OK humano de ${approvedBy} para ${ok.head.slice(0, 8)}: "${quote}"` });
    return text(`OK humano registrado para ${headSha(repoDir)} (${approvedBy}). Anotalo también donde lo pida el flujo del repo.`);
  }),
);

server.registerTool(
  "close_ticket",
  {
    description: "Cierra un ticket que no pasa por gate: consulta respondida, o derivado a humano. Para tickets con código, el cierre lo hace run_gate.",
    inputSchema: {
      ...optionalTicket,
      outcome: z.enum(["answered", "escalated"]),
      note: z.string(),
    },
  },
  safe(({ ticketId, outcome, note }) => {
    const id = ticketOrActive(ticketId);
    updateState(repoDir, id, (st) => {
      st.status = outcome;
      st.summary = note;
    });
    appendJournal(repoDir, id, { kind: outcome === "answered" ? "progress" : "escalation", text: note });
    return text(`Ticket ${id}: ${outcome}.`);
  }),
);

await server.connect(new StdioServerTransport());
