import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { repoKey } from "../core/git.js";
import type { Lane, Risk, TriageResult } from "../core/types.js";

/**
 * MEMORIA DE TRABAJO (el "pizarrón").
 * Vive FUERA de los worktrees para que varios agentes del mismo ticket
 * (cada uno en su worktree de Orca) la compartan.
 *   <data>/state/<repo>/<ticket>.json           estado
 *   <data>/state/<repo>/<ticket>.journal.jsonl  bitácora append-only
 * En cada worktree, .harness/run/active.json dice qué ticket se está trabajando.
 */

export type TicketStatus = "open" | "gate-passed" | "escalated" | "answered" | "closed" | "delegated" | "waiting-user";

export interface TicketState {
  ticketId: string;
  title: string;
  source?: string;
  createdAt: string;
  triage?: TriageResult;
  lane?: Lane;
  laneHistory: { lane: Lane; reason: string; at: string }[];
  gateAttempts: number;
  gatePassed?: { diffHash: string; at: string };
  stopBlocks: number;
  status: TicketStatus;
  summary?: string;
  risk?: Risk;
  /** Flujo del repo al que se delegó (lanes.delegate). */
  delegatedTo?: string;
  /** Rama base para ESTE ticket (la pide el usuario; p. ej. cuando el arnés aún no está en la base). */
  baseOverride?: string;
  /** Motivo de la pausa (status waiting-user). */
  waitingFor?: string;
}

export interface JournalEntry {
  at: string;
  kind: "hypothesis" | "discarded" | "progress" | "decision" | "gate" | "escalation" | "plan";
  text: string;
  agent?: string;
}

export function dataDir(): string {
  return process.env.CLAUDE_PLUGIN_DATA || process.env.DEV_HARNESS_DATA || join(homedir(), ".dev-harness");
}

function stateDir(repoDir: string): string {
  return join(dataDir(), "state", repoKey(repoDir));
}

function safeId(id: string): string {
  return id.replace(/[^\w.-]+/g, "_");
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

export function statePath(repoDir: string, ticketId: string): string {
  return join(stateDir(repoDir), `${safeId(ticketId)}.json`);
}

export function loadState(repoDir: string, ticketId: string): TicketState | undefined {
  const p = statePath(repoDir, ticketId);
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as TicketState) : undefined;
}

export function saveState(repoDir: string, state: TicketState): void {
  atomicWrite(statePath(repoDir, state.ticketId), JSON.stringify(state, null, 2));
}

export function updateState(repoDir: string, ticketId: string, fn: (s: TicketState) => void): TicketState {
  const s = loadState(repoDir, ticketId);
  if (!s) throw new Error(`No existe el ticket ${ticketId}. Llamá primero a start_ticket.`);
  fn(s);
  saveState(repoDir, s);
  return s;
}

export function createState(repoDir: string, ticketId: string, title: string, source?: string): TicketState {
  const existing = loadState(repoDir, ticketId);
  if (existing) return existing;
  const s: TicketState = {
    ticketId,
    title,
    source,
    createdAt: new Date().toISOString(),
    laneHistory: [],
    gateAttempts: 0,
    stopBlocks: 0,
    status: "open",
  };
  saveState(repoDir, s);
  return s;
}

export function appendJournal(repoDir: string, ticketId: string, entry: Omit<JournalEntry, "at">): void {
  const p = join(stateDir(repoDir), `${safeId(ticketId)}.journal.jsonl`);
  mkdirSync(dirname(p), { recursive: true });
  appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}

export function readJournal(repoDir: string, ticketId: string): JournalEntry[] {
  const p = join(stateDir(repoDir), `${safeId(ticketId)}.journal.jsonl`);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as JournalEntry);
}

// --- ticket activo del worktree ---

const ACTIVE = ".harness/run/active.json";

export function setActiveTicket(repoDir: string, ticketId: string): void {
  atomicWrite(join(repoDir, ACTIVE), JSON.stringify({ ticketId }, null, 2));
}

export function getActiveTicket(repoDir: string): string | undefined {
  const p = join(repoDir, ACTIVE);
  if (!existsSync(p)) return undefined;
  try {
    return (JSON.parse(readFileSync(p, "utf8")) as { ticketId?: string }).ticketId;
  } catch {
    return undefined;
  }
}
