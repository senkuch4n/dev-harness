---
name: lane-hotfix
description: Carril para bugs críticos de producción. Mitigar primero, investigar hipótesis en paralelo, fix mínimo, humano en el loop desde el inicio.
---
# Carril hotfix

**Prioridad: frenar el daño.** Hay un humano de guardia: mantenelo informado en cada paso.

## 1. Avisar
Comentá en el ticket (o en Linear con `orca linear`) que el arnés empezó y cuál es el impacto que entendiste.

## 2. Mitigar (requiere OK humano)
Proponé la mitigación más rápida y reversible:
- Apagar un feature flag (tool `toggle_flag`, con `approvedBy`).
- Revertir el último deploy (`git revert <sha>` en una rama, PR aparte).
- Desactivar la ruta en nginx o devolver un 503 controlado.

**No ejecutes la mitigación sin una confirmación explícita del humano en la conversación.**

## 3. Hipótesis en paralelo
1. Llamá a `search_past_tickets` con el síntoma: la primera hipótesis sale de incidentes anteriores.
2. Armá entre 2 y 4 hipótesis distintas. Por ejemplo: el último deploy (`git log --since=2.days`), datos corruptos en Postgres, caché de Redis desactualizada o con TTL mal puesto, configuración de nginx o de Docker, un servicio externo.
3. Lanzá un subagente `hotfix-investigator` por hipótesis, **todos en el mismo mensaje** para que corran en paralelo.
4. Con lo que devuelvan, elegí la hipótesis confirmada. Si ninguna se confirma en ~15 minutos, escalá: `close_ticket` (escalated) con todo lo encontrado.

## 4. Fix mínimo
1. Subagente `bug-reproducer` sobre la hipótesis confirmada (si es muy urgente, un test de integración alcanza).
2. Subagente `bug-fixer`: el cambio más chico posible, sin refactor.

## 5. Gate y PR
`run_gate` corre unit + smoke de los flujos críticos (no la suite completa). Después seguí la skill `open-pr` con el label `hotfix`.

## 6. Seguimiento
En la descripción del PR incluí:
- Que la suite e2e completa corre post-deploy.
- Un ticket de seguimiento para el fix de fondo, si el fix fue un parche.
- Un borrador de post-mortem: qué pasó, impacto, causa, cómo se detectó y qué lo evitaría.
Si el incidente revela una regla útil, usá `propose_lesson`.
