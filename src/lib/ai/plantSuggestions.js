/**
 * PLANT SUGGESTIONS (sin base de especies propia)
 * -------------------------------------------------
 * Genera sugerencias de especies usando el conocimiento general de Claude,
 * condicionado por las variables del sitio (sol, suelo, drenaje, ubicacion,
 * uso, estilo, mantenimiento). NO hay una base de datos de especies propia
 * detras -- el modelo es la fuente, y por eso cada sugerencia se guarda como
 * "propuesta" para que un profesional (paisajista) la valide o corrija.
 *
 * IMPORTANTE: esto es una decision de producto explicita, no una limitacion
 * oculta -- la audiencia son especialistas, no consumidores finales sin
 * conocimiento de paisajismo, asi que la IA no necesita garantizar
 * compatibilidad con reglas deterministicas (eso queda para una fase futura
 * si se decide construir una base de especies real).
 */
const fetch = require('node-fetch');

const SYSTEM_PROMPT = `Sos un asistente de paisajismo que sugiere especies vegetales para un profesional (paisajista/arquitecto paisajista) que va a revisar y ajustar tu propuesta -- no es un consumidor final sin conocimiento.
Tu tarea es sugerir entre 5 y 10 especies apropiadas segun las condiciones del sitio dadas.
Usa tu conocimiento general de botanica y paisajismo. Priorizá especies razonablemente disponibles en vivero en la region indicada si se conoce.
Si una condicion del sitio es "no_se" o no fue provista, no la asumas -- sugerí especies robustas/tolerantes a un rango amplio para esa variable, y decilo en el motivo.
NUNCA inventes datos tecnicos falsos (tamaño adulto, floracion, etc.) -- si no estas seguro de un dato preciso, dalo como aproximado, nunca como certeza.
Respondé UNICAMENTE con JSON valido (sin markdown), con este formato exacto:
{"suggestions":[{"common_name":"","scientific_name":"","sun":"pleno sol|parcial|sombra|amplio rango","water":"bajo|medio|alto","soil":"","adult_size":"","growth_rate":"lento|medio|rapido","bloom_season":"","foliage":"perenne|caduca","maintenance":"bajo|medio|alto","reason":"por que se ajusta a estas condiciones, 1-2 oraciones"}]}`;

function buildUserMessage(conditions) {
  const {
    location, sunExposure, orientation, soilType, drainage,
    style, maintenanceLevel, purposeTags = [], budgetLevel,
  } = conditions;

  const lines = [
    location ? `Ubicación: ${location}` : 'Ubicación: no especificada',
    `Sol: ${sunExposure || 'no_se'}`,
    `Orientación: ${orientation || 'no_se'}`,
    `Suelo: ${soilType || 'no_se'}`,
    `Drenaje: ${drainage || 'no_se'}`,
    style ? `Estilo del proyecto: ${style}` : null,
    maintenanceLevel ? `Mantenimiento deseado: ${maintenanceLevel}` : null,
    purposeTags.length ? `Uso del espacio: ${purposeTags.join(', ')}` : null,
    budgetLevel ? `Presupuesto: ${budgetLevel}` : null,
  ].filter(Boolean);

  return `Condiciones del sitio:\n${lines.join('\n')}\n\nSugerí especies apropiadas para estas condiciones.`;
}

async function suggestPlants(conditions) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY no esta configurada.');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(conditions) }],
    }),
  });

  const rawText = await res.text();
  let data;
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new Error(`Claude devolvio una respuesta no-JSON (status ${res.status}): ${rawText.slice(0, 300)}`);
  }
  if (!res.ok) throw new Error(data.error?.message || `Error Claude API (status ${res.status})`);

  const text = data.content?.find((block) => block.type === 'text')?.text?.trim();
  if (!text) throw new Error('Claude no devolvio contenido de texto.');

  const cleaned = text.replace(/^```json\s*|```$/g, '').trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Claude no devolvio JSON valido: ${cleaned.slice(0, 300)}`);
  }

  return parsed.suggestions || [];
}

module.exports = { suggestPlants };
