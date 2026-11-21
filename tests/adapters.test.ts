import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { HarnessConfigSchema } from "../src/core/config.js";
import { runGate, gateStatusForStop } from "../src/core/gate.js";
import { diffHash } from "../src/core/git.js";
import { parseRiskOutput } from "../src/core/risk.js";
import { planTests } from "../src/core/test-planner.js";
import { searchMemory } from "../src/memory/episodes.js";
import { createState, loadState, setActiveTicket, updateState } from "../src/memory/state.js";

const DIST = resolve("dist");
let repo: string;
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { cwd: repo, stdio: "ignore" });
const commit = (msg: string) => {
  sh("git", ["add", "-A"]);
  sh("git", ["commit", "-qm", msg]);
};

/** Repo estilo Evidentia: riesgo y specs afectados por scripts propios, rama base develop. */
function makeRepo(riskLevel = "medio", suiteCompleta = false) {
  repo = mkdtempSync(join(tmpdir(), "harness-adapt-"));
  process.env.DEV_HARNESS_DATA = mkdtempSync(join(tmpdir(), "harness-data-"));
  sh("git", ["init", "-q", "-b", "develop"]);
  sh("git", ["config", "user.email", "t@t"]);
  sh("git", ["config", "user.name", "t"]);
  mkdirSync(join(repo, "ops/harness"), { recursive: true });
  mkdirSync(join(repo, ".harness"), { recursive: true });
  mkdirSync(join(repo, "client/components"), { recursive: true });
  mkdirSync(join(repo, "progress"), { recursive: true });
  writeFileSync(join(repo, "ops/harness/riesgo.sh"), `#!/usr/bin/env bash\necho "RIESGO: $(cat ops/harness/nivel 2>/dev/null || echo ${riskLevel})"\necho "  server/src/auth/x.ts  (autenticación)"\n`);
  chmodSync(join(repo, "ops/harness/riesgo.sh"), 0o755);
  writeFileSync(
    join(repo, "ops/harness/specs.mjs"),
    `console.log(JSON.stringify({ suiteCompleta: ${suiteCompleta}, motivosSuiteCompleta: ${suiteCompleta ? '["client/app/layout.tsx: layout raíz"]' : "[]"}, e2e: [{ spec: "tests/buzon.spec.ts", nombre: "buzon", motivos: [] }], jest: [], nodeTestClient: ["lib/a.test.ts"], nodeTestHarness: false }))`,
  );
  writeFileSync(
    join(repo, ".harness/config.json"),
    JSON.stringify({
      baseBranch: "develop",
      remote: "gitlab-cloud",
      protectedBranches: ["develop", "main"],
      lanes: { delegate: { bugfix: "RDD/SDD", "full-feature": "RDD/SDD" }, base: { hotfix: "main" } },
      adapters: {
        risk: { command: "./ops/harness/riesgo.sh {base}" },
        testPlan: { command: "node ops/harness/specs.mjs {base}", nodeTestClient: "test ! -f FAIL && echo node-test {files}" },
      },
      commands: { typecheck: [{ paths: ["client/**"], cwd: "client", command: "true" }] },
      memory: { searchPaths: ["progress/*.md"], episodesDir: "progress", filePrefix: "carril_" },
      guard: { humanOkForHighRiskPush: true, forbiddenCommands: [{ pattern: "migration:revert", reason: "no" }] },
    }),
  );
  writeFileSync(join(repo, "progress/review_buzon-filtro-fecha.md"), "# Review buzón\nEl filtro de fecha del buzón fallaba con zona horaria UTC-3.\n");
  writeFileSync(join(repo, "progress/impl_frontend_calendario.md"), "# Calendario\nEventos de la grilla mensual.\n");
  writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 1;\n");
  commit("init");
  sh("git", ["checkout", "-qb", "feat/1"]);
}

function ticket(lane: "fast-feature" | "hotfix" = "fast-feature") {
  createState(repo, "#10", "Color del botón del buzón");
  setActiveTicket(repo, "#10");
  updateState(repo, "#10", (s) => {
    s.lane = lane;
    s.laneHistory.push({ lane, reason: "test", at: "" });
  });
}
const summary = { symptom: "s", rootCause: "n/a", fix: "f" };
const hook = (name: string, input: object) =>
  spawnSync("node", [join(DIST, `${name}.mjs`)], { input: JSON.stringify({ cwd: repo, ...input }), encoding: "utf8", env: process.env });

describe("adaptador de riesgo", () => {
  it("parsea la salida de riesgo.sh", () => {
    const cfg = HarnessConfigSchema.parse({ commands: {}, adapters: { risk: { command: "x" } } });
    expect(parseRiskOutput("RIESGO: alto\n  server/src/auth/a.ts  (auth)\n", cfg)).toEqual({ level: "high", files: ["server/src/auth/a.ts"] });
    expect(parseRiskOutput("RIESGO: bajo\n(sin cambios contra HEAD)\n", cfg).level).toBe("low");
  });
});

describe("plan desde specs-afectados", () => {
  it("e2e afectados quedan para el revisor si no hay comando e2eSpecs", () => {
    const cfg = HarnessConfigSchema.parse({ commands: {}, adapters: { testPlan: { command: "x", jest: "cd server && npx jest --ci {patterns}" } } });
    const plan = planTests(["server/src/a.ts"], "fast-feature", cfg, undefined, {
      suiteCompleta: false, motivosSuiteCompleta: [], e2e: [{ spec: "tests/a.spec.ts", nombre: "a", motivos: [] }], jest: ["src/a/"], nodeTestClient: [],
    });
    expect(plan.gate.map((s) => s.command)).toContain("cd server && npx jest --ci src/a/");
    expect(plan.gate.some((s) => s.level === "e2e")).toBe(false);
    expect(plan.pendingForReview[0]).toMatch(/E2E afectados \(1\): a/);
  });
});

describe("gate en modo adaptador (Evidentia)", () => {
  beforeEach(() => makeRepo());

  it("exige el trabajo commiteado, corre lo afectado y escribe el episodio en progress/", async () => {
    ticket();
    writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 2;\n");
    const g0 = await runGate(repo, "#10", summary);
    expect(g0.message).toMatch(/commiteá/);
    commit("wip");
    const g = await runGate(repo, "#10", summary);
    expect(g.passed).toBe(true);
    expect(g.message).toMatch(/PENDIENTE PARA EL REVISOR/);
    expect(g.message).toMatch(/buzon/);
    expect(readdirSync(join(repo, "progress")).some((f) => f.startsWith("carril_"))).toBe(true);
    // commitear el episodio no invalida el gate (hash por contenido, no por commit)
    commit("episodio");
    expect(gateStatusForStop(repo, "#10").mustBlock).toBe(false);
  });

  it("riesgo alto en carril rápido → re-carril delegado al flujo del repo", async () => {
    ticket();
    writeFileSync(join(repo, "ops/harness/nivel"), "alto");
    writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 9;\n");
    commit("wip");
    const g = await runGate(repo, "#10", summary);
    expect(g.message).toMatch(/RE-CARRIL[\s\S]*RDD\/SDD/);
    const s = loadState(repo, "#10")!;
    expect(s.lane).toBe("full-feature");
    expect(s.status).toBe("delegated");
    expect(gateStatusForStop(repo, "#10").mustBlock).toBe(false);
  });

  it("cambio global (suite completa) en carril rápido también re-carrila", async () => {
    makeRepo("medio", true);
    ticket();
    writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 5;\n");
    commit("wip");
    const g = await runGate(repo, "#10", summary);
    expect(g.message).toMatch(/algo global/);
  });

  it("hotfix compara contra main, no contra develop", async () => {
    sh("git", ["checkout", "-q", "develop"]);
    sh("git", ["branch", "main"]);
    writeFileSync(join(repo, "client/components/Otro.tsx"), "x\n");
    commit("trabajo en develop que no está en main");
    sh("git", ["checkout", "-q", "-b", "hotfix/1", "main"]);
    ticket("hotfix");
    writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 7;\n");
    commit("fix");
    const g = await runGate(repo, "#10", summary);
    expect(g.passed).toBe(true);
    expect(readdirSync(join(repo, "progress")).filter((f) => f.startsWith("carril_")).length).toBe(0); // incidentes van a su carpeta
  });
});

describe("guardas con riesgo alto", () => {
  beforeEach(() => makeRepo("alto"));

  it("bloquea el push sin OK humano y lo permite con OK para ese HEAD", async () => {
    writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 3;\n");
    commit("cambio alto");
    const r1 = hook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "git push -u gitlab-cloud HEAD" } });
    expect(r1.status).toBe(2);
    expect(r1.stderr).toMatch(/OK del usuario/);

    // el agente no puede fabricar el OK
    expect(hook("pre-tool-guard", { tool_name: "Write", tool_input: { file_path: join(repo, ".harness/run/ok-humano.json") } }).status).toBe(2);
    expect(hook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "echo {} > .harness/run/ok-humano.json" } }).status).toBe(2);

    const { writeHumanOk } = await import("../src/core/human-ok.js");
    writeHumanOk(repo, "Joel", "dale, pusheá");
    expect(hook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "git push -u gitlab-cloud HEAD" } }).status).toBe(0);

    // si el código cambia, el OK ya no vale
    writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 4;\n");
    commit("otro cambio");
    expect(hook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "git push" } }).status).toBe(2);
  });

  it("bloquea push desde develop y comandos prohibidos del repo", () => {
    sh("git", ["checkout", "-q", "develop"]);
    expect(hook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "git push" } }).status).toBe(2);
    expect(hook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "cd server && npm run migration:revert" } }).status).toBe(2);
    expect(hook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "glab mr merge 12" } }).status).toBe(2);
  });
});

describe("memoria sobre la historia del repo", () => {
  beforeEach(() => makeRepo());
  it("busca en progress/ aunque no tenga frontmatter", () => {
    const cfg = HarnessConfigSchema.parse({ commands: {}, memory: { searchPaths: ["progress/*.md"] } });
    const hits = searchMemory(repo, "filtro fecha buzón", { cfg });
    expect(hits[0].path).toBe("progress/review_buzon-filtro-fecha.md");
    expect(hits[0].title).toBe("Review buzón");
  });
  it("el hash no cambia al commitear el mismo contenido", () => {
    writeFileSync(join(repo, "client/components/Boton.tsx"), "export const a = 8;\n");
    const before = diffHash(repo, "develop");
    commit("x");
    expect(diffHash(repo, "develop")).toBe(before);
    expect(existsSync(join(repo, ".harness/config.json"))).toBe(true);
  });
});
