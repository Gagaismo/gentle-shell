# Coding standards

Reglas de juicio sobre cómo se escribe el código en este repo. Las reglas mecánicas viven en la CI y en [`orca-stack lint`](https://github.com/Gagaismo/orca-stack/blob/main/docs/manual.md#lint); las de producto, en `AGENTS.md`.

## La regla de los comentarios

Todo comentario de código cae en uno de cuatro tipos, y cada tipo dice qué hacer con él:

| Type | Action |
|---|---|
| Tautology | Delete it. |
| Excuse | Delete it and open an issue to fix the implementation. |
| Stale | Delete it. |
| Decision Record | Move it to an ADR. |

Fuente: Matt Pocock, https://x.com/mattpocockuk/status/2123798388227403983.

El único comentario permitido es un Decision Record que cita un ADR o un issue `#n`. `orca-stack lint` aplica la parte mecánica de esta regla en JavaScript, TypeScript, Go, Python y Shell; lo demás lo aplica quien revisa.

## La integración con Orca vive en archivos propios del fork

Este repo es un fork de `Gentleman-Programming/gentle-shell`. La integración nativa con Orca vive en archivos propios del fork (`extensions/orca-*.ts`, `lib/orca-*`, `scripts/orca-*`) y toca el core de upstream solo en seams chicos, como el preflight de G1 o el consentimiento de G2, para que cada release de upstream siga siendo un merge barato. Un cambio que reparte lógica de Orca en archivos de upstream más allá de un seam lleva su razón en el cuerpo del PR.

Fuente: orca-stack ADR 0006, punto 4.
