import { spawn } from "node:child_process";
import type { StepResult, TestStep } from "./types.js";

const MAX_OUTPUT = 6000;

/** Recorta la salida dejando el final, que es donde suelen estar los errores. */
export function tail(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : `…(recortado)…\n${text.slice(-max)}`;
}

export function runStep(step: TestStep, cwd: string, timeoutMs: number): Promise<StepResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", step.command], { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
    let out = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, Math.max(1000, timeoutMs));

    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ step, ok: code === 0 && !timedOut, durationMs: Date.now() - started, output: tail(out), timedOut });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ step, ok: false, durationMs: Date.now() - started, output: String(err), timedOut });
    });
  });
}

/** Corre los pasos en orden, frena en el primer fallo y respeta el presupuesto total. */
export async function runSteps(steps: TestStep[], cwd: string, budgetMinutes: number): Promise<StepResult[]> {
  const deadline = Date.now() + budgetMinutes * 60_000;
  const results: StepResult[] = [];
  for (const step of steps) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      results.push({ step, ok: false, durationMs: 0, output: "Sin presupuesto de tiempo restante.", timedOut: true });
      break;
    }
    const r = await runStep(step, cwd, remaining);
    results.push(r);
    if (!r.ok) break;
  }
  return results;
}

export function summarize(results: StepResult[]): string {
  return results
    .map((r) => {
      const head = `${r.ok ? "✔" : "✘"} [${r.step.level}] ${r.step.reason} — ${(r.durationMs / 1000).toFixed(1)}s${r.timedOut ? " (TIMEOUT)" : ""}\n  $ ${r.step.command}`;
      return r.ok ? head : `${head}\n${r.output}`;
    })
    .join("\n\n");
}
