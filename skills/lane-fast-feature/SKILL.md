---
name: lane-fast-feature
description: Carril para features de bajo riesgo (visuales, de texto o de diseño). Un solo agente ReAct más un evaluator–optimizer visual. Sin orquestador ni workers.
---
# Carril fast-feature

Un cambio chico no necesita un equipo: un agente ReAct y un evaluador visual alcanzan.

## Loop evaluator–optimizer (máximo 3 vueltas)
1. **Implementar**: subagente `ui-implementer`. Devuelve las URLs afectadas.
2. **Levantar la app** si no está corriendo (por ejemplo `docker compose up -d` o `npm run dev --workspace=apps/web` en background) y esperá a que responda.
3. **Evaluar**: subagente `visual-evaluator` con las URLs y el ticket (y el mockup, si hay).
4. Si `approved: false`, pasale los `issues` al `ui-implementer` y repetí desde 1.
5. Si después de 3 vueltas sigue sin aprobar, explicá qué falta y llamá a `close_ticket` (escalated).

## Cierre
- `run_gate` corre lint, tipos, unit afectados, regresión visual y el smoke de las pantallas tocadas. **No corre la suite e2e completa.**
- Si `run_gate` responde **RE-CARRIL** (el cambio tocó algo crítico), no lo fuerces: seguí la skill `lane-full-feature`.
- PR: skill `open-pr`. Adjuntá los screenshots de `.harness/run/screenshots/` en la descripción.

Revisión humana: alcanza con una revisión liviana, pero el PR igual lo aprueba una persona.
