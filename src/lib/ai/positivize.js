/**
 * flux-2-pro no soporta negative_prompt (ver promptEngine.js / modelConfig.js).
 * Esta función toma lo que el usuario escribió como "cosas que NO quiere"
 * (en criollo, tipo "no quiero pileta grande, nada de reja blanca") y lo
 * reescribe como instrucciones POSITIVAS que el modelo sí interpreta bien.
 *
 * Usa Claude Haiku vía la API de Anthropic — mismo patrón que ya usás en
 * otros proyectos de Docta Nexus. Requiere ANTHROPIC_API_KEY en el entorno.
 *
 * Si no hay API key configurada, devuelve null (el llamador debe simplemente
 * NO incluir nada en el prompt en ese caso — nunca mandar la versión negativa
 * cruda al modelo, eso es peor que no decir nada).
 */
const fetch = require('node-fetch');

const SYSTEM_PROMPT = `Convertís restricciones de diseño de paisajismo escritas en negativo a instrucciones
POSITIVAS y concretas para un modelo de generación de imágenes (FLUX.2) que no entiende negaciones.

Reglas:
- Nunca uses palabras como "no", "sin", "evitar", "nada de" en tu respuesta.
- Cada restricción negativa se convierte en una descripción positiva de lo que SÍ debe haber.
- Ejemplo: "no quiero pileta grande" -> "piscina de tamaño compacto y proporcional al espacio disponible"
- Ejemplo: "nada de reja blanca" -> "cerramiento en tonos naturales, madera o metal oscuro"
- Ejemplo: "sin plantas espinosas" -> "vegetación de hojas suaves y no punzantes, apta para uso familiar"
- Respondé en inglés (el prompt final va en inglés), en 1-3 oraciones cortas, sin explicaciones ni comillas.
- Si el texto no tiene nada claramente convertible, devolvé una cadena vacía.`;

async function positivizeAvoidList(avoidText) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !avoidText?.trim()) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: avoidText.trim() }],
      }),
    });

    if (!res.ok) {
      console.error('Error de Claude API al positivizar:', await res.text());
      return null;
    }

    const data = await res.json();
    const text = data.content?.find((block) => block.type === 'text')?.text?.trim();
    return text || null;
  } catch (err) {
    console.error('Error llamando a Claude API:', err);
    return null; // fail-safe: mejor no incluir nada que arriesgar una frase negativa
  }
}

module.exports = { positivizeAvoidList };
