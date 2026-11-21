---
name: setup-harness
description: Prepara un repo para usar el arnés - crea .harness/config.json adaptado a su stack, las carpetas de memoria y las entradas de .gitignore.
---
# Preparar un repo para el arnés

1. Copiá la plantilla: `mkdir -p .harness && cp -n "${CLAUDE_PLUGIN_ROOT}/templates/.harness/config.json" .harness/config.json`
2. Creá la memoria: `mkdir -p .harness/memory/{episodes,incidents,lessons/pending}` y `cp -n "${CLAUDE_PLUGIN_ROOT}/templates/.harness/memory/lessons/approved.md" .harness/memory/lessons/approved.md`
3. Agregá `.harness/run/` al `.gitignore`.
4. **Adaptá la config al repo real** leyendo su estructura. Es una propuesta: el humano la aprueba.
   - Rutas de los apps (`apps/api`, `apps/web` u otras) y sus scripts de `package.json` (jest o vitest, lint, build).
   - `criticalPaths`: auth, guards, pagos, migraciones (TypeORM o Prisma), Dockerfiles, compose, nginx y CI.
   - `testImpact`: mapeá cada módulo de NestJS y cada sección de Next.js a los tags de Playwright que existan (`grep -r "@[a-z]" e2e/`). Si los tests e2e no tienen tags, sugerí agregarlos.
   - `servicesUp`: el compose de test con Postgres y Redis.
5. Mostrale la config al usuario, explicale cada sección y esperá su OK antes de commitear.

Nota: `.harness/config.json` está protegido por el hook. Después del setup, los cambios los hace un humano.
