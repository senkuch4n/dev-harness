# Lecciones aprobadas

Reglas que el equipo aprendió y que los agentes deben respetar. Solo se agregan por PR revisado por un humano
(los agentes proponen en `lessons/pending/`).

Formato: una sección `## <módulo o "General">` con reglas cortas y su porqué.

## General
- Toda migración de Postgres debe ser reversible: un `down` probado.
- Al cambiar datos que se cachean en Redis, invalidá o versioná la clave en el mismo cambio.
