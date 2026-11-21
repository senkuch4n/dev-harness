import type { Lane, TriageResult } from "./types.js";

/**
 * Política de carriles: DETERMINÍSTICA.
 * El LLM (subagente triage) clasifica; este código decide el carril.
 * Cambiar una regla = cambiar este archivo, no un prompt.
 */
export function selectLane(t: TriageResult, minConfidence = 0.7): { lane: Lane; reason: string } {
  if (t.confidence < minConfidence) {
    return { lane: "human-triage", reason: `Confianza ${t.confidence} < ${minConfidence}: lo clasifica un humano.` };
  }

  switch (t.type) {
    case "bug":
      if (t.urgency === "critical") return { lane: "hotfix", reason: "Bug crítico: mitigar primero, arreglar después." };
      return { lane: "bugfix", reason: "Bug no crítico: reproducir → localizar → arreglar." };

    case "feature":
      if (t.risk === "low") return { lane: "fast-feature", reason: "Feature de bajo riesgo: ReAct + evaluator–optimizer." };
      return { lane: "full-feature", reason: `Feature de riesgo ${t.risk}: spec aprobada → orquestador–workers.` };

    case "question":
      return { lane: "query", reason: "Consulta: agente de solo lectura, sin PR." };

    case "chore":
    case "docs":
      if (t.risk === "high") return { lane: "full-feature", reason: `${t.type} de riesgo alto: se trata como feature completa.` };
      return { lane: "chore", reason: `${t.type}: chain simple a PR.` };

    default:
      return { lane: "human-triage", reason: "Tipo desconocido." };
  }
}

/** Carriles que producen código y por lo tanto deben pasar el gate. */
export function laneRequiresGate(lane: Lane): boolean {
  return lane !== "query" && lane !== "human-triage";
}

/** Carriles donde el agente no puede editar archivos. */
export function laneIsReadOnly(lane: Lane): boolean {
  return lane === "query" || lane === "human-triage";
}
