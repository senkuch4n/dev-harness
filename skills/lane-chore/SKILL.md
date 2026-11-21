---
name: lane-chore
description: Carril para chores y docs - actualizar dependencias, refactors chicos, configuración, documentación. Chain simple a PR.
---
# Carril chore / docs

1. Hacé el cambio directamente: no hace falta un subagente.
   - **Dependencias**: actualizá de a un paquete o grupo relacionado y leé el changelog de las versiones major. Para NestJS y Next.js, revisá las guías de migración oficiales.
   - **Docs**: verificá contra el código que lo que documentás es cierto.
2. `run_checks`.
3. `check_risk`. Si toca Docker, nginx, CI o variables de entorno, va a escalar, y está bien que así sea.
4. `run_gate` (si son solo docs no corre tests).
5. Skill `open-pr`. Si cambiaron dependencias, aclarale al revisor que la suite completa corre en el nightly.
