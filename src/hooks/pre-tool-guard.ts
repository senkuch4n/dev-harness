#!/usr/bin/env node
/**
 * Hook PreToolUse: los "no" que el LLM no puede negociar.
 * - Nadie hace push a ramas protegidas, push --force ni merge de PRs (eso es humano).
 * - Comandos prohibidos del repo (suite e2e completa, borrar volúmenes, resetear la DB…).
 * - Carril de consulta = solo lectura.
 * - El agente no edita las reglas que lo controlan (.harness/config.json, lecciones aprobadas).
 */
import { hasConfig, loadConfig } from "../core/config.js";
import { currentBranch } from "../core/git.js";
import { checkBash } from "../core/guard-rules.js";
import { laneIsReadOnly } from "../core/lane-policy.js";
import { getActiveTicket, loadState } from "../memory/state.js";
import { allow, block, guard, readInput } from "./common.js";

const PROTECTED_FILES = [/(^|\/)\.harness\/config\.json$/, /(^|\/)\.harness\/memory\/lessons\/approved\.md$/];
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
    allow();
  }

  if (EDIT_TOOLS.has(tool)) {
    const path = String(ti.file_path ?? ti.notebook_path ?? "");
    if (PROTECTED_FILES.some((re) => re.test(path))) {
      block("Ese archivo define las reglas del arnés: lo cambia un humano. Si creés que hay que cambiarlo, proponelo con propose_lesson o en el resumen del PR.");
    }
    if (lane && laneIsReadOnly(lane)) block(`El carril "${lane}" es de solo lectura: respondé en el ticket sin editar archivos.`);
  }

  allow();
});
