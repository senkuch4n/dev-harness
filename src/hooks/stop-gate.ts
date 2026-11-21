#!/usr/bin/env node
/**
 * Hook Stop: el agente no puede "decir que terminó" sin un gate OK para el diff actual.
 * Es el evaluator–optimizer forzado por código: si bloqueamos, el agente sigue trabajando.
 * Tiene un tope para no generar un loop infinito: al superarlo, deja salir y marca "escalado".
 */
import { hasConfig, loadConfig } from "../core/config.js";
import { gateStatusForStop } from "../core/gate.js";
import { appendJournal, getActiveTicket, saveState } from "../memory/state.js";
import { allow, guard, readInput } from "./common.js";

guard(() => {
  const input = readInput();
  const repoDir = input.cwd || process.cwd();
  if (!hasConfig(repoDir)) allow();

  const ticketId = getActiveTicket(repoDir);
  if (!ticketId) allow(); // sesión normal, fuera del arnés

  const status = gateStatusForStop(repoDir, ticketId);
  if (!status.mustBlock || !status.state) allow();

  const s = status.state;
  const cfg = loadConfig(repoDir);
  const maxStopBlocks = cfg.gate.maxAttempts + 2;
  s.stopBlocks += 1;

  if (s.stopBlocks > maxStopBlocks) {
    s.status = "escalated";
    saveState(repoDir, s);
    appendJournal(repoDir, ticketId, { kind: "escalation", text: "El agente intentó terminar varias veces sin gate OK: escalado a humano." });
    process.stdout.write(
      JSON.stringify({ systemMessage: `[dev-harness] ${ticketId} escalado a humano: no pasó el gate.` }),
    );
    allow();
  }

  saveState(repoDir, s);
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: `[dev-harness] ${status.reason} Ticket ${ticketId} (carril ${s.lane}). Llamá a la tool run_gate con el resumen (symptom, rootCause, fix). Si falla, corregí y reintentá. Si necesitás una respuesta o una acción del usuario para seguir, llamá a pause_ticket con lo que necesitás (eso te deja terminar el turno sin cerrar el ticket). Si ya no se puede avanzar, close_ticket con outcome "escalated". (aviso ${s.stopBlocks}/${maxStopBlocks})`,
    }),
  );
  allow();
});
