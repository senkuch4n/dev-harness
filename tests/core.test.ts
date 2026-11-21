import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HarnessConfigSchema } from "../src/core/config.js";
import { checkBash } from "../src/core/guard-rules.js";
import { selectLane } from "../src/core/lane-policy.js";
import { assessRisk } from "../src/core/risk.js";
import { flowsFor, planTests } from "../src/core/test-planner.js";
import type { TriageResult } from "../src/core/types.js";

const cfg = HarnessConfigSchema.parse(JSON.parse(readFileSync("templates/.harness/config.json", "utf8")));

const t = (o: Partial<TriageResult>): TriageResult => ({
  type: "feature",
  risk: "low",
  urgency: "normal",
  modules: [],
  confidence: 0.9,
  rationale: "",
  ...o,
});

describe("política de carriles", () => {
  it("bug crítico → hotfix", () => expect(selectLane(t({ type: "bug", urgency: "critical" })).lane).toBe("hotfix"));
  it("bug normal → bugfix", () => expect(selectLane(t({ type: "bug" })).lane).toBe("bugfix"));
  it("feature de bajo riesgo → fast-feature (ReAct, no orquestador)", () => expect(selectLane(t({})).lane).toBe("fast-feature"));
  it("feature de riesgo medio → full-feature", () => expect(selectLane(t({ risk: "medium" })).lane).toBe("full-feature"));
  it("consulta → query", () => expect(selectLane(t({ type: "question" })).lane).toBe("query"));
  it("confianza baja → humano", () => expect(selectLane(t({ confidence: 0.5 })).lane).toBe("human-triage"));
});

describe("escalador de riesgo", () => {
  it("feature visual que toca auth se escala", () => {
    const r = assessRisk(["apps/web/styles/a.css", "apps/api/src/auth/jwt.strategy.ts"], "fast-feature", cfg);
    expect(r.mustEscalate).toBe(true);
    expect(r.escalateTo).toBe("full-feature");
  });
  it("feature visual pura no se escala", () => {
    const r = assessRisk(["apps/web/components/Button.tsx"], "fast-feature", cfg);
    expect(r.mustEscalate).toBe(false);
  });
  it("bugfix en código crítico no cambia de carril pero suma flujos críticos", () => {
    const r = assessRisk(["apps/api/src/auth/auth.service.ts"], "bugfix", cfg);
    expect(r.mustEscalate).toBe(false);
    expect(r.extraFlows).toEqual(["auth", "smoke"]);
  });
  it("Dockerfile y nginx son críticos", () => {
    expect(assessRisk(["apps/api/Dockerfile"], "chore", cfg).mustEscalate).toBe(true);
    expect(assessRisk(["nginx/default.conf"], "chore", cfg).mustEscalate).toBe(true);
  });
});

describe("test planner", () => {
  it("test impact: archivos → flujos", () => {
    expect(flowsFor(["apps/api/src/users/users.service.ts"], cfg)).toEqual(["users"]);
  });

  it("feature rápida: el loop interno nunca corre e2e", () => {
    const plan = planTests(["apps/web/components/Button.tsx"], "fast-feature", cfg);
    expect(plan.inner.some((s) => s.level === "e2e")).toBe(false);
    expect(plan.gate.some((s) => s.command.includes("@visual"))).toBe(true);
    expect(plan.gate.filter((s) => s.command.includes("playwright")).length).toBe(1); // sin duplicar la corrida
    expect(plan.budgetMinutes).toBe(10);
  });

  it("unit solo de los archivos afectados y relativo al cwd del app", () => {
    const plan = planTests(["apps/api/src/users/users.service.ts"], "bugfix", cfg);
    const unit = plan.inner.find((s) => s.level === "unit")!;
    expect(unit.command).toBe("cd apps/api && npx jest --findRelatedTests src/users/users.service.ts --passWithNoTests");
  });

  it("el gate filtra e2e por flujo y nunca corre la suite completa", () => {
    const plan = planTests(["apps/api/src/users/users.service.ts"], "bugfix", cfg);
    const e2e = plan.gate.find((s) => s.level === "e2e")!;
    expect(e2e.command).toBe("npx playwright test --grep @users");
  });

  it("hotfix: smoke de flujos críticos, e2e completo diferido", () => {
    const plan = planTests(["apps/api/src/orders/orders.service.ts"], "hotfix", cfg);
    expect(plan.gate.find((s) => s.level === "e2e")?.command).toBe("npx playwright test --grep '@auth|@smoke'");
    expect(plan.deferred[0]).toMatch(/completa/);
  });

  it("e2e/integration levantan Postgres y Redis primero", () => {
    const plan = planTests(["apps/api/src/users/users.service.ts"], "bugfix", cfg);
    expect(plan.gate[0].command).toContain("docker compose");
  });

  it("solo docs: sin gate", () => {
    expect(planTests(["docs/arquitectura.md"], "chore", cfg).gate).toEqual([]);
  });
});

describe("guardas de Bash", () => {
  const opts = { protectedBranches: cfg.protectedBranches, branch: "feat/LIN-1", forbidden: cfg.guard.forbiddenCommands };
  it.each([
    ["git push origin main", /protegidas/],
    ["git push --force origin feat/x", /force/],
    ["git push origin HEAD:main", /protegidas/],
    ["gh pr merge 12", /humano/],
    ["npx playwright test", /e2e completa/],
    ["docker compose down -v", /volúmenes/],
    ["psql -c 'DROP TABLE users'", /Postgres/],
    ["redis-cli FLUSHALL", /Redis/],
  ])("bloquea: %s", (cmd, why) => expect(checkBash(cmd, opts)).toMatch(why));

  it.each([
    "git push -u origin feat/LIN-1",
    "npx playwright test --grep @users",
    "docker compose up -d postgres",
    "git push origin feat/maintenance-page",
  ])("permite: %s", (cmd) => expect(checkBash(cmd, opts)).toBeUndefined());

  it("desde una rama protegida no se pushea nada", () => {
    expect(checkBash("git push", { ...opts, branch: "main" })).toMatch(/creá una rama/);
  });
});
