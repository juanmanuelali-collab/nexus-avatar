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
✅ Webhook con verificación HMAC + idempotencia + descarga a Storage permanente
✅ Auth real (JWT de Supabase Auth) en todas las rutas + chequeo de ownership por proyecto
✅ Subida de imágenes (`/upload` para foto real, `/references` para boceto/estilo/elemento) a Supabase Storage
✅ Sistema de créditos — chequeo antes de generar, débito recién tras aceptar la prediction, reintegro automático si falla/cancela (función atómica en DB para evitar condiciones de carrera)
✅ Rutas base: crear/listar proyectos (con `input_mode`), generar, historial, saldo de créditos, estado puntual de generación
✅ Frontend (Vanilla JS SPA) — auth, crear proyecto con selector de modo (sección 8.1), subida de foto/boceto/referencia, generación con polling y mensajes de estado, comparador before/after, historial
✅ Controles avanzados: descripción libre, "qué evitar" (positivizado vía Claude), paleta de color, encuadre, clima de luz, aspect ratio — prompt armado como JSON estructurado
⬜ Confirmar nombre exacto del campo `input_images` contra schema vivo de Replicate
⬜ Endpoints `/regenerate` y `/edit` (el botón "Volver a intentar" del frontend hoy dispara una generación nueva, no una edición real vinculada por `parent_generation_id`)
⬜ Renovación de signed URLs de Storage (hoy duran 1 año, pero conviene un mecanismo de refresh)
⬜ Endpoint para que el usuario compre/vea sus créditos (hoy sólo hay auto-otorgamiento de 10 gratis al primer uso, pensado para la etapa de test)
⬜ Confirmación de email de Supabase Auth — el frontend hoy asume que el signup puede requerir confirmación; revisar la config de Auth en Supabase (Confirm email on/off) según qué tan fricción-less querés el alta

## Frontend

SPA en Vanilla JS (`src/public/`), sin build step — Express la sirve tal cual como estática. Usa `@supabase/supabase-js` desde CDN para auth (email/password) y habla con el backend vía `fetch` con el JWT de la sesión.

Identidad visual: pensada como software de diseño arquitectónico (grilla tipo plano técnico, tipografía Fraunces + Inter + IBM Plex Mono para lo "técnico"), no como una app de generación de IA genérica — en línea con la sección 41 de la spec.

El selector "¿Qué querés usar para comenzar?" (sección 8.1) muestra/oculta los bloques de subida (foto real, boceto, referencia) según el `input_mode` elegido al crear el proyecto.

`GET /config.js` inyecta `SUPABASE_URL` y `SUPABASE_ANON_KEY` al navegador en runtime (ambos son públicos por diseño — el anon key está protegido por RLS del lado de Supabase, a diferencia del service_role key que nunca sale del backend).

## Controles avanzados de generación

Además del flujo base (elementos, estilo, presupuesto), el usuario puede:

- **Descripción libre** — texto en sus propias palabras, se suma como `subjects[].description` adicional en el prompt JSON.
- **"Qué NO querés"** — como flux-2-pro no soporta `negative_prompt`, esto se manda a **Claude Haiku** (`src/lib/ai/positivize.js`) para reescribirlo en positivo antes de tocar el prompt del modelo (ej. "nada de pileta grande" → "piscina de tamaño compacto"). Si falla o no hay `ANTHROPIC_API_KEY`, ese campo simplemente se ignora — nunca se manda la versión negativa cruda.
- **Paleta de color** — hasta 3 colores por hex, atados a una etiqueta (ej. "vegetación"), siguiendo la recomendación de BFL de asociar hex codes a objetos específicos en vez de usarlos sueltos.
- **Encuadre** (plano general / medio / detalle) y **clima de luz** (mañana, atardecer, noche, nublado) — se incorporan a los campos `camera` y `lighting` del JSON estructurado.
- **Formato de salida** (aspect ratio) — cuadrado, vertical, panorámico, o `match_input_image` (default cuando hay foto real, para preservar el encuadre original).

El prompt final se arma como **JSON estructurado** (`scene`, `subjects`, `style`, `color_palette`, `lighting`, `camera`, etc.) en vez de texto libre — es el modo que BFL recomienda para flujos de producción con estructura consistente, que es exactamente este caso.

## Rediseño mobile-first + fixes de UX (post-lanzamiento en Render)

- **Bug de `[hidden]`**: elementos con `display` propio en su CSS (spinners, pantallas) ignoraban el atributo `hidden` porque una regla de origen "author" siempre le gana a la regla nativa `[hidden]{display:none}` del navegador, sin importar especificidad. Se agregó una regla global `[hidden] { display: none !important; }` en `style.css` que lo soluciona para toda la app, no solo los casos puntuales encontrados.
- **Descarga**: el botón de descarga usaba un `<a download>` apuntando directo a la URL de Supabase Storage — cross-origin, así que el navegador ignora `download` y termina navegando fuera de la app. Ahora descarga el archivo como blob local antes de disparar la descarga (`app.js`), sin salir nunca de la SPA.
- **Comparación antes/después**: se reemplazó el slider de arrastre (incómodo en mobile) por dos pestañas simples "Antes" / "Después".
- **Tira de materiales usados**: el panel de resultado ahora muestra miniaturas de las imágenes que efectivamente se usaron en esa generación (foto real + referencias), no solo el resultado final.
- **Mobile-first real**: el CSS se reescribió con base mobile (una columna, rail colapsable en menú hamburguesa, dropzones más grandes y táctiles, botón "Generar propuesta" sticky al fondo de la pantalla) y el layout de escritorio como mejora agregada vía `@media (min-width: 900px)`, no al revés.

## Variables de entorno

Ver `.env.example`. `SUPABASE_URL` apunta al proyecto `nexus-reporting` (schema `landscape`, uso temporal de test).

**Importante**: para que `@supabase/supabase-js` lea/escriba en el schema `landscape`, hay que exponerlo en Supabase → Settings → API → "Exposed schemas" (ya hecho).

## Próximos pasos sugeridos

1. Confirmar el campo real de multi-imagen del modelo (primera llamada de prueba real a Replicate)
2. Deploy en Render (variables de entorno directo en el dashboard de Render, no en `.env`)
3. Revisar en Supabase → Authentication → Providers → Email si "Confirm email" está activo (afecta si el signup del frontend deja entrar directo o pide confirmar por mail)
4. Una vez deployado y con URL pública: sacar `REPLICATE_WEBHOOK_SECRET` del dashboard de Replicate y cargarlo en Render
5. Apuntar `paisajismo.doctanexus.com` desde Hostinger (CNAME al servicio de Render)
6. Antes de abrir a clientes reales: reemplazar el auto-otorgamiento de créditos gratis por un flujo de compra/plan real
