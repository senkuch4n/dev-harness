---
name: open-pr
description: Cierre común de los carriles con código - commit (incluye el episodio de memoria), push de la rama y PR/MR (GitHub o GitLab) con un resumen para el revisor humano.
---
# Abrir el PR

Requisito: `run_gate` respondió **GATE OK** para el diff actual.

1. `git status`. Incluí en el commit el episodio que generó el gate y las lecciones pendientes (la ruta te la dio `run_gate`; por defecto `.harness/memory/`).
2. Commit con un mensaje convencional: `fix(orders): ...`, `feat(web): ...`, `chore(deps): ...`. Referenciá el ticket.
3. `git push -u <remoto> HEAD` (el remoto es el de la config; el hook bloquea ramas protegidas y, con riesgo alto, el push sin OK humano registrado).
4. Abrí el PR/MR contra la base del carril:
   - **GitHub:** `gh pr create --title "<tipo>(<módulo>): <resumen> [<ID>]" --body-file .harness/run/pr-body.md`
   - **GitLab:** `glab mr create --title "…" --description "$(cat .harness/run/pr-body.md)" --target-branch <base>` o el MCP de GitLab. Si el repo tiene template de MR (`.gitlab/merge_request_templates/`), usá ese formato y completalo con lo de abajo.

   Cuerpo:

```markdown
## Ticket
<link o ID> — carril: <lane> (<por qué>)

## Qué cambió y por qué
...

## Cómo se verificó
<copiá el resumen del gate: qué corrió y cuánto tardó>
Diferido: suite e2e completa en el nightly / post-deploy.

## Riesgos y rollback
...

## Memoria
- Episodio: .harness/memory/...
- Lecciones propuestas (requieren aprobación): ...
```

5. Actualizá el ticket: link del PR/MR y estado (Linear con `orca linear`, GitHub con `gh issue comment`, GitLab con su MCP o `glab issue note`, respetando los labels de estado que use el repo).
6. **No mergees.** El merge lo hace un humano.
