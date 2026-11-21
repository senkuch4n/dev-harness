---
name: lane-full-feature
description: Carril para features de riesgo medio o alto (o escaladas). Spec aprobada por un humano, orquestador con workers por capa, integrador y revisor.
---
# Carril full-feature

## 1. Spec (con aprobación humana antes de codear)
1. Subagente `planner`: escribe `.harness/run/spec-<ticket>.md`.
2. Mostrale la spec al usuario y **esperá su aprobación explícita**. Si hay cambios, volvé al planner.
3. Guardá la aprobación: `update_ticket_state` (kind `plan`, texto "spec aprobada por <quién>").

## 2. Workers (orquestador–workers)
- Lanzá un subagente `worker` por cada tarea de la spec, **en el mismo mensaje** para que corran en paralelo. Pasale a cada uno su tarea y su lista de archivos.
- Las tareas tienen archivos disjuntos (lo garantiza la spec), así que pueden trabajar en el mismo worktree.
- Si la feature es muy grande, podés repartirla en worktrees de Orca: un agente por tarea, con su ticket, compartiendo la memoria del arnés.

## 3. Integrar
Subagente `integrator`: resuelve los pedidos cruzados y verifica que cada criterio tenga código y test.

## 4. Revisar
Subagente `reviewer`. Si hay problemas `blocking`, derivalos al worker o al integrador correspondiente (máximo 2 vueltas).

## 5. Gate final
`run_gate` corre build, lint, tipos, unit, integración (con Postgres y Redis de prueba) y e2e **solo de los flujos tocados**. Si falla, derivá el reporte al worker de esa capa y reintentá (máximo 3).

## 6. PR
Skill `open-pr`. Incluí la spec en la descripción, el plan de rollback y las migraciones de Postgres, si hay.
