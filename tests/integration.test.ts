import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { runGate } from "../src/core/gate.js";
import { createState, loadState, setActiveTicket, updateState } from "../src/memory/state.js";

const DIST = resolve("dist");
let repo: string;

function sh(cmd: string, args: string[]) {
  execFileSync(cmd, args, { cwd: repo, stdio: "ignore" });
}

/** Repo de prueba: los "tests" pasan o fallan según exista el archivo FAIL. */
function makeRepo() {
  repo = mkdtempSync(join(tmpdir(), "harness-repo-"));
  process.env.DEV_HARNESS_DATA = mkdtempSync(join(tmpdir(), "harness-data-"));
  sh("git", ["init", "-q", "-b", "main"]);
  sh("git", ["config", "user.email", "t@t"]);
  sh("git", ["config", "user.name", "t"]);
  mkdirSync(join(repo, ".harness"), { recursive: true });
  writeFileSync(
    join(repo, ".harness/config.json"),
    JSON.stringify({
      criticalPaths: ["api/src/auth/**"],
      testImpact: { "web/**": ["visual"] },
      commands: {
        typecheck: "true",
        unit: [{ paths: ["**"], command: "test ! -f FAIL" }],
        visual: "echo visual-ok",
      },
    }),
  );
  mkdirSync(join(repo, "web"), { recursive: true });
  writeFileSync(join(repo, "web/button.tsx"), "export const a = 1;\n");
  sh("git", ["add", "."]);
  sh("git", ["commit", "-qm", "init"]);
  sh("git", ["checkout", "-qb", "feat/LIN-1"]);
}

function startTicket(lane: "fast-feature" | "bugfix" = "fast-feature") {
  createState(repo, "LIN-1", "Cambiar color del botón");
  setActiveTicket(repo, "LIN-1");
  updateState(repo, "LIN-1", (s) => {
    s.lane = lane;
    s.laneHistory.push({ lane, reason: "test", at: "" });
  });
}

const summary = { symptom: "Botón gris", rootCause: "n/a", fix: "Color primario" };

function runHook(name: string, input: object) {
  return spawnSync("node", [join(DIST, `${name}.mjs`)], { input: JSON.stringify({ cwd: repo, ...input }), encoding: "utf8", env: process.env });
}

beforeEach(makeRepo);

describe("gate + hook Stop (evaluator–optimizer forzado)", () => {
  it("falla, se corrige y pasa; escribe el episodio", async () => {
    startTicket();
    writeFileSync(join(repo, "web/button.tsx"), "export const a = 2;\n");
    writeFileSync(join(repo, "FAIL"), "");

    const g1 = await runGate(repo, "LIN-1", summary);
    expect(g1.passed).toBe(false);
    expect(g1.attempt).toBe(1);

    // El hook Stop bloquea mientras no haya gate OK
    const stop1 = runHook("stop-gate", { hook_event_name: "Stop" });
    expect(stop1.status).toBe(0);
    expect(JSON.parse(stop1.stdout).decision).toBe("block");

    sh("rm", ["FAIL"]);
    const g2 = await runGate(repo, "LIN-1", summary);
    expect(g2.passed).toBe(true);
    expect(readdirSync(join(repo, ".harness/memory/episodes")).length).toBe(1);

    // Con gate OK para este diff, deja terminar
    const stop2 = runHook("stop-gate", { hook_event_name: "Stop" });
    expect(stop2.stdout).toBe("");

    // Si el código cambia después del gate, vuelve a bloquear
    writeFileSync(join(repo, "web/button.tsx"), "export const a = 3;\n");
    expect(JSON.parse(runHook("stop-gate", {}).stdout).decision).toBe("block");
  });

  it("al tercer fallo escala a humano", async () => {
    startTicket();
    writeFileSync(join(repo, "FAIL"), "");
    writeFileSync(join(repo, "web/button.tsx"), "x\n");
    await runGate(repo, "LIN-1", summary);
    await runGate(repo, "LIN-1", summary);
    const g3 = await runGate(repo, "LIN-1", summary);
    expect(g3.escalated).toBe(true);
    expect(loadState(repo, "LIN-1")?.status).toBe("escalated");
    expect(runHook("stop-gate", {}).stdout).toBe(""); // escalado: lo deja salir
  });

  it("feature rápida que toca auth se re-carrila a full-feature", async () => {
    startTicket();
    mkdirSync(join(repo, "api/src/auth"), { recursive: true });
    writeFileSync(join(repo, "api/src/auth/jwt.ts"), "x\n");
    const g = await runGate(repo, "LIN-1", summary);
    expect(g.passed).toBe(false);
    expect(g.message).toMatch(/RE-CARRIL/);
    expect(loadState(repo, "LIN-1")?.lane).toBe("full-feature");
  });

  it("sin ticket activo, el hook Stop no interfiere", () => {
    expect(runHook("stop-gate", {}).stdout).toBe("");
  });
});

describe("hook PreToolUse", () => {
  it("bloquea push a main con exit 2", () => {
    const r = runHook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "git push origin main" } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/protegidas/);
  });
  it("protege las reglas del arnés", () => {
    const r = runHook("pre-tool-guard", { tool_name: "Edit", tool_input: { file_path: join(repo, ".harness/config.json") } });
    expect(r.status).toBe(2);
  });
  it("carril de consulta: solo lectura", () => {
    createState(repo, "LIN-2", "¿Cómo se calcula el envío?");
    setActiveTicket(repo, "LIN-2");
    updateState(repo, "LIN-2", (s) => (s.lane = "query"));
    const r = runHook("pre-tool-guard", { tool_name: "Write", tool_input: { file_path: join(repo, "web/x.ts") } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/solo lectura/);
  });
  it("deja pasar comandos normales", () => {
    expect(runHook("pre-tool-guard", { tool_name: "Bash", tool_input: { command: "npm test" } }).status).toBe(0);
  });
});

describe("servidor MCP (tool use)", () => {
  it("expone las tools y decide el carril de forma determinística", async () => {
    const client = new Client({ name: "test", version: "1" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [join(DIST, "mcp-server.mjs")],
        cwd: repo,
        env: { ...process.env, DEV_HARNESS_REPO: repo } as Record<string, string>,
      }),
    );
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["start_ticket", "select_lane", "run_checks", "run_gate", "search_past_tickets", "update_ticket_state", "propose_lesson"]),
    );

    await client.callTool({ name: "start_ticket", arguments: { ticketId: "LIN-9", title: "Nuevo banner", body: "" } });
    const res = (await client.callTool({
      name: "select_lane",
      arguments: { type: "feature", risk: "low", urgency: "normal", modules: ["web"], confidence: 0.9, rationale: "visual" },
    })) as { content: { text: string }[] };
    expect(JSON.parse(res.content[0].text).lane).toBe("fast-feature");
    expect(existsSync(join(repo, ".harness/run/active.json"))).toBe(true);
    await client.close();
  });
});
