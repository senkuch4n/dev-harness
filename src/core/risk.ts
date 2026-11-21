import picomatch from "picomatch";
import type { HarnessConfig } from "./config.js";
import type { Lane, RiskAssessment } from "./types.js";

export function matchesAny(file: string, globs: string[]): boolean {
  if (globs.length === 0) return false;
  return picomatch(globs, { dot: true })(file);
}

/** Carriles "livianos" que no pueden tocar rutas críticas sin escalar. */
const LIGHT_LANES: Lane[] = ["fast-feature", "chore"];

/**
 * Escalador de riesgo: mira el DIFF REAL, no lo que dijo el triage.
 * - Carril liviano + ruta crítica  → escala a full-feature.
 * - Cualquier carril + ruta crítica/compartida → suma los flujos críticos al gate.
 */
export function assessRisk(files: string[], lane: Lane, cfg: HarnessConfig): RiskAssessment {
  const criticalFiles = files.filter((f) => matchesAny(f, cfg.criticalPaths));
  const sharedFiles = files.filter((f) => matchesAny(f, cfg.sharedPaths));

  const touchesCritical = criticalFiles.length > 0;
  const touchesShared = sharedFiles.length > 0;
  const mustEscalate = touchesCritical && LIGHT_LANES.includes(lane);

  const extraFlows = touchesCritical || touchesShared ? [...cfg.criticalFlows] : [];

  let reason = "El diff no toca rutas críticas ni compartidas.";
  if (mustEscalate) {
    reason = `El carril "${lane}" tocó rutas críticas (${criticalFiles.join(", ")}). Se escala a full-feature: hace falta spec aprobada y revisión completa.`;
  } else if (touchesCritical) {
    reason = `Toca rutas críticas (${criticalFiles.join(", ")}): se agregan los flujos críticos al gate.`;
  } else if (touchesShared) {
    reason = `Toca código compartido (${sharedFiles.join(", ")}): se agregan los flujos críticos al gate.`;
  }

  return {
    criticalFiles,
    sharedFiles,
    mustEscalate,
    escalateTo: mustEscalate ? "full-feature" : undefined,
    extraFlows,
    reason,
  };
}
