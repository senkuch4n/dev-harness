import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Configuración que vive en el repo del SISTEMA (no en el arnés):
 *   <repo>/.harness/config.json
 * El arnés es genérico; todo lo específico del stack está acá.
 *
 * Dos modos:
 *  - Autónomo: el arnés usa sus propias reglas (criticalPaths, testImpact).
 *  - Adaptador: el repo ya tiene sus scripts (riesgo, specs afectados, flujo propio)
 *    y el arnés los llama en vez de reemplazarlos (`adapters`, `lanes.delegate`).
 */
const ScopedCommand = z.object({
  /** Globs de archivos a los que aplica este comando. */
  paths: z.array(z.string()),
  /** Comando. Placeholders: {files} (archivos afectados, relativos a cwd), {base}. */
  command: z.string(),
  /** Directorio desde donde correr el comando (relativo a la raíz). */
  cwd: z.string().default("."),
  /** Si es true, {files} se reescribe relativo a `cwd`. */
  relativeFiles: z.boolean().default(true),
});
export type ScopedCommandT = z.infer<typeof ScopedCommand>;

/** Un comando simple, o uno por lado del repo (solo corre si el diff toca esas rutas). */
const CommandOrScoped = z.union([z.string(), z.array(ScopedCommand)]);

const LaneBudget = z.object({ gateMinutes: z.number().positive() });

const LaneName = z.enum(["hotfix", "bugfix", "fast-feature", "full-feature", "query", "chore", "human-triage"]);

export const HarnessConfigSchema = z.object({
  baseBranch: z.string().default("main"),
  /** Remoto contra el que se compara (`<remote>/<baseBranch>`). */
  remote: z.string().default("origin"),
  protectedBranches: z.array(z.string()).default(["main", "master"]),

  /** Rutas donde un cambio sube el riesgo (auth, pagos, migraciones, infra). Modo autónomo. */
  criticalPaths: z.array(z.string()).default([]),
  /** Código compartido: un cambio acá puede afectar todo. Modo autónomo. */
  sharedPaths: z.array(z.string()).default([]),

  /** Test impact analysis: glob -> flujos e2e que lo cubren. Modo autónomo. */
  testImpact: z.record(z.string(), z.array(z.string())).default({}),
  /** Flujos que siempre se protegen (smoke de hotfix, cambios en código compartido). */
  criticalFlows: z.array(z.string()).default([]),
  /** Cómo se transforma un flujo en el filtro del runner e2e. Ej: "@{flow}". */
  e2eTagFormat: z.string().default("@{flow}"),

  commands: z.object({
    build: CommandOrScoped.optional(),
    lint: CommandOrScoped.optional(),
    typecheck: CommandOrScoped.optional(),
    unit: z.array(ScopedCommand).default([]),
    integration: z.array(ScopedCommand).default([]),
    /** Corre e2e filtrados por tag. Placeholder {grep} = tags unidos con "|". */
    e2e: z.string().optional(),
    /** Corre una lista de specs e2e. Placeholder {specs}. Si falta, los specs quedan para el revisor. */
    e2eSpecs: z.string().optional(),
    visual: z.string().optional(),
    /** Screenshot de una URL. Placeholders: {url} {out}. */
    screenshot: z.string().optional(),
    /** Comando para servicios que necesitan los tests (Postgres, Redis...). */
    servicesUp: z.string().optional(),
  }),

  /** Usar los scripts que el repo ya tiene en vez de las reglas del arnés. */
  adapters: z
    .object({
      risk: z
        .object({
          /** Ej: "./ops/harness/riesgo.sh {base}". Debe imprimir el nivel. */
          command: z.string(),
          levelRegex: z.string().default("RIESGO:\\s*(\\w+)"),
          /** Líneas con archivos que justifican el nivel. Grupo 1 = ruta. */
          fileRegex: z.string().default("^\\s+(\\S+)\\s+\\("),
          levels: z.record(z.string(), z.enum(["low", "medium", "high"])).default({
            bajo: "low",
            medio: "medium",
            alto: "high",
            low: "low",
            medium: "medium",
            high: "high",
          }),
        })
        .optional(),
      testPlan: z
        .object({
          /** Ej: "node ops/harness/specs-afectados.mjs {base} --hasta HEAD --json". Requiere el trabajo commiteado. */
          command: z.string(),
          format: z.literal("specs-afectados").default("specs-afectados"),
          /** Placeholder {patterns}. */
          jest: z.string().optional(),
          /** Placeholder {files}. */
          nodeTestClient: z.string().optional(),
          /** Placeholder {files}. */
          nodeTestHarness: z.string().optional(),
        })
        .optional(),
    })
    .default({}),

  /** Nombre del subagente que cumple cada rol (para reusar los del repo). */
  agents: z.record(z.string(), z.string()).default({}),

  lanes: z
    .object({
      /** Carriles que resuelve el flujo propio del repo. Valor = cómo se llama ese flujo. */
      delegate: z.partialRecord(LaneName, z.string()).default({}),
      /** Rama base por carril (p. ej. hotfix sale de la rama de producción). */
      base: z.partialRecord(LaneName, z.string()).default({}),
    })
    .default({ delegate: {}, base: {} }),

  memory: z
    .object({
      /** Dónde buscar tickets e historia (globs). */
      searchPaths: z.array(z.string()).default([".harness/memory/episodes/*.md", ".harness/memory/incidents/*.md"]),
      episodesDir: z.string().default(".harness/memory/episodes"),
      incidentsDir: z.string().default(".harness/memory/incidents"),
      filePrefix: z.string().default(""),
      approvedLessons: z.string().default(".harness/memory/lessons/approved.md"),
      pendingLessonsDir: z.string().default(".harness/memory/lessons/pending"),
    })
    .default({
      searchPaths: [".harness/memory/episodes/*.md", ".harness/memory/incidents/*.md"],
      episodesDir: ".harness/memory/episodes",
      incidentsDir: ".harness/memory/incidents",
      filePrefix: "",
      approvedLessons: ".harness/memory/lessons/approved.md",
      pendingLessonsDir: ".harness/memory/lessons/pending",
    }),

  budgets: z.record(z.string(), LaneBudget).default({}),

  guard: z
    .object({
      /** Regex (string) de comandos prohibidos para el agente. Prefijo "(?i)" = sin distinguir mayúsculas. */
      forbiddenCommands: z.array(z.object({ pattern: z.string(), reason: z.string() })).default([]),
      /** Archivos que el agente no puede editar (regex sobre la ruta). */
      protectedFiles: z.array(z.string()).default([]),
      /** Con riesgo alto, `git push` exige un OK humano registrado para el HEAD actual. */
      humanOkForHighRiskPush: z.boolean().default(false),
      /** El agente no puede editar el archivo de lecciones aprobadas (las cambia un humano). */
      protectApprovedLessons: z.boolean().default(true),
    })
    .default({ forbiddenCommands: [], protectedFiles: [], humanOkForHighRiskPush: false, protectApprovedLessons: true }),

  /** Mitigación de hotfix. Placeholders {flag} {state}. */
  featureFlags: z.object({ toggleCommand: z.string() }).optional(),

  gate: z
    .object({
      maxAttempts: z.number().int().positive().default(3),
      /** Con adaptador de test plan, exigir que el trabajo esté commiteado antes del gate. */
      requireCommitted: z.boolean().default(true),
      /** Archivos sueltos que nunca cuentan como cambio del ticket (globs). */
      ignoreFiles: z.array(z.string()).default(["*.patch", "*.diff", "*.orig", "*.rej", "**/.DS_Store", "*.swp", "*.swo", "**/.*.swp", "**/.*.swo"]),
    })
    .default({ maxAttempts: 3, requireCommitted: true, ignoreFiles: ["*.patch", "*.diff", "*.orig", "*.rej", "**/.DS_Store", "*.swp", "*.swo", "**/.*.swp", "**/.*.swo"] }),
  triage: z.object({ minConfidence: z.number().min(0).max(1).default(0.7) }).default({ minConfidence: 0.7 }),
});

export type HarnessConfig = z.infer<typeof HarnessConfigSchema>;

export const CONFIG_RELATIVE_PATH = ".harness/config.json";

export function loadConfig(repoDir: string): HarnessConfig {
  const path = join(repoDir, CONFIG_RELATIVE_PATH);
  if (!existsSync(path)) {
    throw new Error(
      `No encontré ${CONFIG_RELATIVE_PATH} en ${repoDir}. Corré la skill /dev-harness:setup-harness para crearlo.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return HarnessConfigSchema.parse(raw);
}

export function hasConfig(repoDir: string): boolean {
  return existsSync(join(repoDir, CONFIG_RELATIVE_PATH));
}

/** Nombre real del subagente para un rol. */
export function agentFor(cfg: HarnessConfig, role: string): string {
  if (cfg.agents[role]) return cfg.agents[role];
  // El plugin no trae revisor de seguridad propio: sin mapeo, revisa el reviewer general.
  if (role === "security-reviewer") return cfg.agents.reviewer ?? "dev-harness:reviewer";
  return `dev-harness:${role}`;
}

export const ROLES = [
  "triage",
  "hotfix-investigator",
  "bug-reproducer",
  "bug-fixer",
  "ui-implementer",
  "visual-evaluator",
  "planner",
  "worker",
  "integrator",
  "reviewer",
  "security-reviewer",
  "query-answerer",
] as const;

export function agentMap(cfg: HarnessConfig): Record<string, string> {
  return Object.fromEntries(ROLES.map((r) => [r, agentFor(cfg, r)]));
}
