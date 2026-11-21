export type TicketType = "bug" | "feature" | "question" | "chore" | "docs";
export type Risk = "low" | "medium" | "high";
export type Urgency = "normal" | "high" | "critical";

export type Lane =
  | "hotfix"
  | "bugfix"
  | "fast-feature"
  | "full-feature"
  | "query"
  | "chore"
  | "human-triage";

export interface TriageResult {
  type: TicketType;
  risk: Risk;
  urgency: Urgency;
  modules: string[];
  confidence: number;
  rationale: string;
}

/** Un paso de verificación ya resuelto a un comando concreto. */
export interface TestStep {
  id: string;
  level: "build" | "lint" | "typecheck" | "unit" | "integration" | "e2e" | "visual";
  command: string;
  reason: string;
}

export interface TestPlan {
  lane: Lane;
  inner: TestStep[];
  gate: TestStep[];
  /** Lo que NO bloquea: corre en nightly o post-deploy. */
  deferred: string[];
  budgetMinutes: number;
  notes: string[];
  /** Lo que el gate no corre y queda para el revisor o la revisión por lote. */
  pendingForReview: string[];
  /** El análisis de impacto pidió la suite completa (cambio global o sin mapeo). */
  fullSuiteRecommended: boolean;
}

export interface RiskAssessment {
  level: Risk;
  criticalFiles: string[];
  sharedFiles: string[];
  mustEscalate: boolean;
  escalateTo?: Lane;
  extraFlows: string[];
  reason: string;
}

export interface StepResult {
  step: TestStep;
  ok: boolean;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

export interface GateResult {
  passed: boolean;
  escalated: boolean;
  attempt: number;
  maxAttempts: number;
  diffHash: string;
  results: StepResult[];
  message: string;
}
