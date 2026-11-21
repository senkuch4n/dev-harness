import { execSync } from "node:child_process";
import picomatch from "picomatch";
import { fill, mergeBase } from "./base.js";
import type { HarnessConfig } from "./config.js";
import type { Lane, Risk, RiskAssessment } from "./types.js";

export function matchesAny(file: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  return picomatch(globs, { dot: true })(file);
}

/** Carriles "livianos" que no pueden tocar rutas críticas sin escalar. */
export const LIGHT_LANES: Lane[] = ["fast-feature", "chore"];

/**
 * Escalador de riesgo (modo autónomo): mira el DIFF REAL, no lo que dijo el triage.
 * - Carril liviano + ruta crítica  → escala a full-feature.
 * - Cualquier carril + ruta crítica/compartida → suma los flujos críticos al gate.
 */
export function assessRisk(files: string[], lane: Lane, cfg: HarnessConfig): RiskAssessment {
  const criticalFiles = files.filter((f) => matchesAny(f, cfg.criticalPaths));
  const sharedFiles = files.filter((f) => matchesAny(f, cfg.sharedPaths));
  const level: Risk = criticalFiles.length ? "high" : files.length ? "medium" : "low";
  return decide(level, criticalFiles, sharedFiles, lane, cfg, "rutas críticas");
}

function decide(
  level: Risk,
  criticalFiles: string[],
  sharedFiles: string[],
  lane: Lane,
  cfg: HarnessConfig,
  source: string,
): RiskAssessment {
  const touchesCritical = level === "high";
  const touchesShared = sharedFiles.length > 0;
  const mustEscalate = touchesCritical && LIGHT_LANES.includes(lane);
  const extraFlows = touchesCritical || touchesShared ? [...cfg.criticalFlows] : [];

  let reason = `Riesgo ${level}: el diff no toca ${source}.`;
  if (mustEscalate) {
    reason = `El carril "${lane}" dio riesgo ALTO (${criticalFiles.join(", ") || "ver salida"}). Se escala a full-feature: hace falta spec aprobada y revisión completa.`;
  } else if (touchesCritical) {
    reason = `Riesgo ALTO (${criticalFiles.join(", ") || "ver salida"}): revisión completa y, si aplica, OK humano antes de pushear.`;
  } else if (touchesShared) {
    reason = `Toca código compartido (${sharedFiles.join(", ")}): se agregan los flujos críticos al gate.`;
  }
  return { level, criticalFiles, sharedFiles, mustEscalate, escalateTo: mustEscalate ? "full-feature" : undefined, extraFlows, reason };
}

/** Parsea la salida del script de riesgo del repo. */
export function parseRiskOutput(output: string, cfg: HarnessConfig): { level: Risk; files: string[] } {
  const a = cfg.adapters.risk!;
  const m = output.match(new RegExp(a.levelRegex, "m"));
  const raw = m?.[1]?.toLowerCase() ?? "";
  const level = a.levels[raw];
  if (!level) throw new Error(`No pude leer el nivel de riesgo de la salida del script:\n${output.slice(0, 500)}`);
  const fileRe = new RegExp(a.fileRegex);
  const files = output
    .split("\n")
    .map((l) => l.match(fileRe)?.[1])
    .filter((x): x is string => Boolean(x));
  return { level, files };
}

/** Riesgo con el script del repo si hay adaptador; si no, con las reglas del arnés. */
export function assessRiskFor(repoDir: string, files: string[], lane: Lane, cfg: HarnessConfig, override?: string): RiskAssessment {
  if (!cfg.adapters.risk) return assessRisk(files, lane, cfg);
  const cmd = fill(cfg.adapters.risk.command, { base: mergeBase(repoDir, cfg, lane, override) });
  let out: string;
  try {
    out = execSync(cmd, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: "/bin/bash" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}` || err.message;
  }
  const { level, files: justifying } = parseRiskOutput(out, cfg);
  const sharedFiles = files.filter((f) => matchesAny(f, cfg.sharedPaths));
  return decide(level, level === "high" ? justifying : [], sharedFiles, lane, cfg, "rutas de riesgo alto");
}
