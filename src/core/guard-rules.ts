/** Reglas del hook PreToolUse, separadas para poder testearlas. */
export interface BashGuardOptions {
  protectedBranches: string[];
  branch: string;
  forbidden: { pattern: string; reason: string }[];
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function checkBash(command: string, opts: BashGuardOptions): string | undefined {
  const cmd = command.replace(/\s+/g, " ").trim();
  const branches = opts.protectedBranches.map(esc).join("|");

  // Cada segmento de una cadena (&&, ;, |) se evalúa por separado.
  for (const part of cmd.split(/&&|\|\||;|\|/).map((p) => p.trim())) {
    if (/^git\b.*\bpush\b/.test(part)) {
      if (/(\s--force(-with-lease)?\b|\s-f\b|\s\+\S)/.test(part)) return "push --force no está permitido para el agente.";
      if (branches && new RegExp(`(\\s|:)(${branches})$|(\\s|:)(${branches})\\s`).test(part))
        return `No se puede hacer push a ramas protegidas (${opts.protectedBranches.join(", ")}). Abrí un PR.`;
      if (opts.protectedBranches.includes(opts.branch))
        return `Estás en "${opts.branch}": creá una rama para el ticket antes de hacer push.`;
    }
    if (/^gh\s+pr\s+merge\b/.test(part) || /^glab\s+mr\s+merge\b/.test(part)) return "El merge lo hace un humano después de revisar el PR/MR.";
    if (/ok-humano\.json/.test(part)) return "El OK humano se registra solo con la tool record_human_ok, después de que el usuario lo diga.";
  }

  for (const f of opts.forbidden) {
    if (toRegExp(f.pattern).test(cmd)) return f.reason;
  }
  return undefined;
}

/** Acepta el prefijo "(?i)" (estilo PCRE) para patrones sin distinguir mayúsculas. */
export function toRegExp(pattern: string): RegExp {
  return pattern.startsWith("(?i)") ? new RegExp(pattern.slice(4), "i") : new RegExp(pattern);
}

/** ¿El comando hace un `git push`? (para el chequeo de riesgo alto). */
export function isPush(command: string): boolean {
  return command
    .replace(/\s+/g, " ")
    .split(/&&|\|\||;|\|/)
    .some((p) => /^git\b.*\bpush\b/.test(p.trim()));
}
