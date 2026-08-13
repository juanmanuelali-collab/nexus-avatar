# AI Landscape Designer (Docta Nexus)

SaaS de diseño de paisajismo asistido por IA. Stack: Node.js/Express + Vanilla JS SPA + Supabase + Replicate, deploy en Render.com.

## Modelo: black-forest-labs/flux-2-pro

- Modelo oficial de Replicate → se llama por `owner/name` (endpoint `/v1/models/.../predictions`), sin fijar version hash.
- Soporta hasta 8 imágenes de referencia por request.
- **NO soporta `negative_prompt`** — confirmado en la documentación oficial de BFL. Todas las restricciones se redactan en positivo dentro del prompt principal (ver `src/lib/promptEngine.js`). Se sigue guardando un `negative_prompt` en la base de datos por trazabilidad, pero nunca se envía a la API.
- **TODO antes de la primera prueba real**: confirmar el nombre exacto del campo de input para múltiples imágenes contra el schema vivo (dejé `input_images` como mejor estimación en `src/lib/ai/replicate/generate.js` y `edit.js`).

## Modo referencia/boceto → paisajismo fotorrealista (sección 8.1)

El producto soporta dos flujos:
1. **Foto real** del espacio → rediseño preservando arquitectura (flujo original, MVP base).
2. **Boceto / referencia / concepto** sin foto real → "Visualización conceptual" (`is_conceptual = true` en la generation).

Y combinaciones: foto+boceto, foto+referencia. La jerarquía de fuentes visuales (foto real > boceto/layout > referencia de estilo > referencias de elementos > texto) vive en `src/lib/promptEngine.js`, función `resolveTransformationType` + `sortReferencesByPriority`. El campo `transformation_type` en `generations` registra cuál de los 6 flujos se usó.

Cuando hay un boceto en juego, el prompt incluye instrucciones específicas para que el modelo interprete líneas/anotaciones como intención espacial y NO reproduzca el trazo del boceto en el resultado final (`sketchInterpretationBlock` en el Prompt Engine).

## Estado actual (esqueleto — NO listo para producción)

✅ Estructura de carpetas, `ImageGenerationProvider` + `ReplicateProvider`
✅ Prompt Engine v2 — jerarquía de fuentes, modo boceto, sin negative_prompt real
✅ Webhook con verificación HMAC + idempotencia (falta implementar descarga a Storage)
✅ Rutas base: crear proyecto (con `input_mode`), generar, historial
⬜ Auth real (hoy hay un placeholder que sólo chequea que exista el header)
⬜ Subida de imágenes (`/upload`, `/references`) a Supabase Storage
⬜ Descarga del output de Replicate → Supabase Storage (hoy el webhook guarda la URL temporal de Replicate)
⬜ Sistema de créditos (`checkUserCredits`)
⬜ Frontend (Vanilla JS SPA) — falta el selector inicial "¿Qué querés usar para comenzar?" de la sección 8.1
⬜ Confirmar nombre exacto del campo `input_images` contra schema vivo de Replicate
⬜ Endpoints `/regenerate` y `/edit`

## Variables de entorno

Ver `.env.example`. `SUPABASE_URL` apunta al proyecto `nexus-reporting` (schema `landscape`, uso temporal de test).

**Importante**: para que `@supabase/supabase-js` lea/escriba en el schema `landscape`, hay que exponerlo en Supabase → Settings → API → "Exposed schemas" (ya hecho).

## Próximos pasos sugeridos

1. Confirmar el campo real de multi-imagen del modelo (primera llamada de prueba real a Replicate)
2. Implementar auth real + subida de imágenes (foto real y/o boceto/referencia según `input_mode`)
3. Implementar descarga del output al webhook (Storage permanente)
4. Frontend: selector inicial de modo + flujo condicional según sección 8.1
5. Deploy en Render + apuntar `paisajismo.doctanexus.com` desde Hostinger
