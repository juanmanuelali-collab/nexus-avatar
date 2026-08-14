/**
 * SITE ANALYSIS (sección 52 del pedido)
 * --------------------------------------
 * Fase de análisis visual automático que corre UNA vez, apenas se sube la
 * foto real del espacio — antes del primer render. Usa Claude (vision) para
 * identificar qué hay en la imagen (arquitectura, vegetación existente,
 * piscina, superficies duras, etc.) y lo guarda en projects.site_analysis.
 *
 * REGLA DE LA SPEC, innegociable: cualquier inferencia acá es una ESTIMACIÓN,
 * nunca una medición certificada. Nunca inventar datos que la imagen no
 * permita inferir razonablemente. Esto se refuerza en el prompt del sistema
 * de Claude y en cómo se consume después (ver promptEngine.js siteAnalysisNote).
 *
 * Si falla (sin ANTHROPIC_API_KEY, error de red, etc.) devuelve null — el
 * resto del flujo sigue funcionando sin análisis, no es bloqueante.
 */
const fetch = require('node-fetch');

const SYSTEM_PROMPT = `Analizás fotos de espacios exteriores residenciales (patios, jardines, terrazas) para una
herramienta de diseño de paisajismo. Tu tarea es identificar QUÉ HAY en la imagen, no proponer diseños.

Respondé ÚNICAMENTE con un JSON válido (sin markdown, sin texto alrededor) con esta forma exacta:
{
  "space_type": "backyard" | "garden" | "terrace" | "frontyard" | "pool_area" | "rooftop" | "other",
  "architecture_detected": boolean,
  "existing_pool": boolean,
  "existing_lawn": boolean,
  "hardscape_detected": boolean,
  "vegetation_detected": boolean,
  "sun_exposure": "estimated_high" | "estimated_medium" | "estimated_low" | "unknown",
  "intervention_zones": string[],
  "confidence": number entre 0 y 1
}

Reglas:
- Todo es una ESTIMACIÓN VISUAL, nunca una medición certificada. No inventes datos que la imagen no permita inferir razonablemente.
- "confidence" debe reflejar honestamente qué tan clara es la imagen (mala luz, ángulo raro, imagen chica -> confidence bajo).
- "intervention_zones" son zonas del espacio que se ven vacías/con potencial de mejora, en 2-4 frases cortas en español.
- No agregues ningún campo fuera de los listados. No agregues explicaciones fuera del JSON.`;

async function analyzeSite(imageUrl) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !imageUrl) return null;

  try {
    // Claude necesita la imagen en base64 — la descargamos desde Storage.
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const buffer = await imgRes.buffer();
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
    const base64 = buffer.toString('base64');

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: contentType, data: base64 } },
              { type: 'text', text: 'Analizá este espacio exterior.' },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      console.error('Error de Claude API en site analysis:', await res.text());
      return null;
    }

    const data = await res.json();
    const text = data.content?.find((block) => block.type === 'text')?.text?.trim();
    if (!text) return null;

    // Por las dudas, si vino con fences de markdown a pesar de la instrucción.
    const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed;
  } catch (err) {
    console.error('Error en analyzeSite:', err);
    return null; // no bloquea el flujo — el proyecto queda sin análisis, nada más
  }
}

module.exports = { analyzeSite };
