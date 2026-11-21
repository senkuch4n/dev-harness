#!/usr/bin/env node
/**
 * Hook PreToolUse: los "no" que el LLM no puede negociar.
 * - Nadie hace push a ramas protegidas, push --force ni merge de PRs (eso es humano).
 * - Comandos prohibidos del repo (suite e2e completa, borrar volúmenes, resetear la DB…).
 * - Carril de consulta = solo lectura.
 * - El agente no edita las reglas que lo controlan (.harness/config.json, lecciones aprobadas).
 */
import { baseRev } from "../core/base.js";
import { hasConfig, loadConfig } from "../core/config.js";
import { changedFiles, currentBranch } from "../core/git.js";
import { checkBash, isPush } from "../core/guard-rules.js";
import { hasHumanOkForHead } from "../core/human-ok.js";
import { assessRiskFor } from "../core/risk.js";
import { laneIsReadOnly } from "../core/lane-policy.js";
import { getActiveTicket, loadState } from "../memory/state.js";
import { allow, block, guard, readInput } from "./common.js";

const BASE_PROTECTED = [/(^|\/)\.harness\/config\.json$/, /(^|\/)\.harness\/run\/ok-humano\.json$/];
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

guard(() => {
  const input = readInput();
  const repoDir = input.cwd || process.cwd();
  if (!hasConfig(repoDir)) allow();

  const cfg = loadConfig(repoDir);
  const tool = input.tool_name ?? "";
  const ti = input.tool_input ?? {};
  const ticketId = getActiveTicket(repoDir);
  const lane = ticketId ? loadState(repoDir, ticketId)?.lane : undefined;

  if (tool === "Bash") {
    const reason = checkBash(String(ti.command ?? ""), {
      protectedBranches: cfg.protectedBranches,
      branch: currentBranch(repoDir),
      forbidden: cfg.guard.forbiddenCommands,
    });
    if (reason) block(reason);

    // Riesgo alto → el push exige un OK humano registrado para este HEAD exacto.
    if (cfg.guard.humanOkForHighRiskPush && isPush(String(ti.command ?? ""))) {
      const files = changedFiles(repoDir, baseRev(repoDir, cfg, lane));
      const risk = assessRiskFor(repoDir, files, lane ?? "bugfix", cfg);
      if (risk.level === "high" && !hasHumanOkForHead(repoDir)) {
        block(
          `Riesgo ALTO (${risk.criticalFiles.slice(0, 5).join(", ") || "ver riesgo"}): no se pushea sin el OK del usuario. Pedíselo explicando qué cambia y cómo se revierte; cuando lo dé, registralo con la tool record_human_ok y reintentá. Integrar en local sí está permitido.`,
        );
      }
    }
    allow();
  }

  if (EDIT_TOOLS.has(tool)) {
    const path = String(ti.file_path ?? ti.notebook_path ?? "");
    const protectedFiles = [...BASE_PROTECTED, ...cfg.guard.protectedFiles.map((p) => new RegExp(p)), ...(cfg.guard.protectApprovedLessons ? [new RegExp(`(^|/)${cfg.memory.approvedLessons.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)] : [])];
    if (protectedFiles.some((re) => re.test(path))) {
      block("Ese archivo define las reglas del arnés: lo cambia un humano. Si creés que hay que cambiarlo, proponelo con propose_lesson o en el resumen del PR.");
    }
    if (lane && laneIsReadOnly(lane)) block(`El carril "${lane}" es de solo lectura: respondé en el ticket sin editar archivos.`);
  }

  allow();
});
