---
name: open-pr
description: Cierre común de los carriles con código - commit (incluye el episodio de memoria), push de la rama y PR con un resumen para el revisor humano.
---
# Abrir el PR

Requisito: `run_gate` respondió **GATE OK** para el diff actual.

1. `git status`. Incluí en el commit los archivos de `.harness/memory/` que generó el gate (el episodio y las lecciones pendientes).
2. Commit con un mensaje convencional: `fix(orders): ...`, `feat(web): ...`, `chore(deps): ...`. Referenciá el ticket.
3. `git push -u origin HEAD` (el hook bloquea el push a ramas protegidas).
4. `gh pr create --title "<tipo>(<módulo>): <resumen> [<ID>]" --body-file .harness/run/pr-body.md` con este cuerpo:

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

5. Si el ticket es de Linear, adjuntá el link del PR y mové el estado con `orca linear` (mirá `orca linear --help`).
6. **No mergees.** El merge lo hace un humano.
