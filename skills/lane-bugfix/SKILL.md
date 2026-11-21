---
name: lane-bugfix
description: Carril para bugs no críticos. Prompt chaining - reproducir con un test, localizar, arreglar, verificar.
---
# Carril bugfix

Cadena de pasos con validación entre cada uno. Si un paso falla, no avances.

1. **Reproducir**: subagente `bug-reproducer`.
   - Gate del paso: tiene que existir un test que falla por el motivo del bug.
   - Si devuelve "no reproducido", comentá en el ticket lo que se probó, pedí más datos y llamá a `close_ticket` (escalated).
2. **Localizar y arreglar**: subagente `bug-fixer`.
   - Gate del paso: el test del bug pasa y `run_checks` da OK.
3. **Revisar**: subagente `reviewer`. Si hay problemas `blocking`, volvé al paso 2 con ese feedback (máximo 2 vueltas).
4. **Gate final**: `run_gate` con symptom, rootCause, fix y notWorked (sacalos de la bitácora con `get_ticket`).
   - Si falla, pasale el reporte a `bug-fixer` y reintentá. El gate tiene un máximo de 3 intentos.
5. **PR**: skill `open-pr`. Si el reviewer propuso `lesson_candidate`, llamá a `propose_lesson`.
