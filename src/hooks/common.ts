import { readFileSync } from "node:fs";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  stop_hook_active?: boolean;
}

export function readInput(): HookInput {
  try {
    return JSON.parse(readFileSync(0, "utf8") || "{}") as HookInput;
  } catch {
    return {};
  }
}

/** Bloquea con exit 2: stderr es lo que lee el agente. */
export function block(reason: string): never {
  process.stderr.write(`[dev-harness] ${reason}\n`);
  process.exit(2);
}

export function allow(): never {
  process.exit(0);
}

/** Un hook nunca debe romper la sesión por un error propio: ante la duda, deja pasar y avisa. */
export function guard(fn: () => void): void {
  try {
    fn();
  } catch (e) {
    process.stderr.write(`[dev-harness] hook con error (no bloquea): ${(e as Error).message}\n`);
    process.exit(1);
  }
}
