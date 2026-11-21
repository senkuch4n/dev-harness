---
name: lane-query
description: Carril para consultas sobre el sistema. Solo lectura, responde en el ticket, sin PR.
---
# Carril query (solo lectura)

En este carril el hook bloquea cualquier edición de archivos.

1. Subagente `query-answerer` con la pregunta.
2. Publicá la respuesta en el ticket (`gh issue comment <n> --body-file -` o con `orca linear`).
3. `close_ticket` con outcome `answered` y un resumen de la respuesta en una línea.
4. Si la respuesta revela un bug o una feature faltante, proponé crear un ticket nuevo: no lo resuelvas acá.
