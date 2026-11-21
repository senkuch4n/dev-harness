import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Configuración que vive en el repo del SISTEMA (no en el arnés):
 *   <repo>/.harness/config.json
 * El arnés es genérico; todo lo específico del stack está acá.
 */
const ScopedCommand = z.object({
  /** Globs de archivos a los que aplica este comando. */
  paths: z.array(z.string()),
  /** Comando. Placeholders: {files} (archivos afectados, relativos a cwd), {grep}. */
  command: z.string(),
  /** Directorio desde donde correr el comando (relativo a la raíz). */
  cwd: z.string().default("."),
  /** Si es true, {files} se reescribe relativo a `cwd`. */
  relativeFiles: z.boolean().default(true),
});

const LaneBudget = z.object({ gateMinutes: z.number().positive() });

export const HarnessConfigSchema = z.object({
  baseBranch: z.string().default("main"),
  protectedBranches: z.array(z.string()).default(["main", "master"]),

  /** Rutas donde un cambio sube el riesgo (auth, pagos, migraciones, infra). */
  criticalPaths: z.array(z.string()).default([]),
  /** Código compartido: un cambio acá puede afectar todo. */
  sharedPaths: z.array(z.string()).default([]),

  /** Test impact analysis: glob -> flujos e2e que lo cubren. */
  testImpact: z.record(z.string(), z.array(z.string())).default({}),
  /** Flujos que siempre se protegen (smoke de hotfix, cambios en código compartido). */
  criticalFlows: z.array(z.string()).default([]),
  /** Cómo se transforma un flujo en el filtro del runner e2e. Ej: "@{flow}". */
  e2eTagFormat: z.string().default("@{flow}"),

  commands: z.object({
    build: z.string().optional(),
    lint: z.string().optional(),
    typecheck: z.string().optional(),
    unit: z.array(ScopedCommand).default([]),
    integration: z.array(ScopedCommand).default([]),
    /** Corre e2e filtrados. Placeholder {grep} = tags unidos con "|". */
    e2e: z.string().optional(),
    visual: z.string().optional(),
    /** Screenshot de una URL. Placeholders: {url} {out}. */
    screenshot: z.string().optional(),
    /** Comando para servicios que necesitan los tests (Postgres, Redis...). */
    servicesUp: z.string().optional(),
  }),

  budgets: z.record(z.string(), LaneBudget).default({}),

  guard: z
    .object({
      /** Regex (string) de comandos prohibidos para el agente. */
      forbiddenCommands: z
        .array(z.object({ pattern: z.string(), reason: z.string() }))
        .default([]),
    })
    .default({ forbiddenCommands: [] }),

  /** Mitigación de hotfix. Placeholders {flag} {state}. */
  featureFlags: z.object({ toggleCommand: z.string() }).optional(),

  gate: z.object({ maxAttempts: z.number().int().positive().default(3) }).default({ maxAttempts: 3 }),
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
