/**
 * Cliente HTTP mínimo para la API de Replicate.
 * Toda la app debe pasar por acá — nunca hacer fetch a Replicate desde otro módulo.
 * REPLICATE_API_TOKEN nunca debe salir de este archivo (y nunca al frontend).
 *
 * flux-2-pro es un modelo OFICIAL de Replicate, así que se corre contra el
 * endpoint /v1/models/{owner}/{name}/predictions, que siempre usa la última
 * versión sin necesidad de fijar un version hash manualmente. Esto es distinto
 * del endpoint genérico /v1/predictions (que sí requiere "version") usado para
 * modelos de la comunidad. Ver modelConfig.js para el razonamiento completo.
 */
const fetch = require('node-fetch');

const REPLICATE_API_BASE = 'https://api.replicate.com/v1';

function getToken() {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) throw new Error('REPLICATE_API_TOKEN no configurado');
  return token;
}

/**
 * Crea una prediction contra un modelo oficial (owner/name), modo asíncrono con webhook.
 * @param {Object} params
 * @param {string} params.modelSlug - ej. "black-forest-labs/flux-2-pro"
 * @param {Object} params.input
 * @param {string} params.webhookUrl
 * @param {string[]} [params.webhookEventsFilter]
 */
async function createModelPrediction({ modelSlug, input, webhookUrl, webhookEventsFilter = ['start', 'completed'] }) {
  const res = await fetch(`${REPLICATE_API_BASE}/models/${modelSlug}/predictions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=0', // no bloquear la request HTTP esperando el resultado
    },
    body: JSON.stringify({
      input,
      webhook: webhookUrl,
      webhook_events_filter: webhookEventsFilter,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Replicate createModelPrediction falló (${res.status}): ${errText}`);
  }

  return res.json();
}

/** Fallback de polling — NO usar como mecanismo principal, sólo si el webhook no llegó */
async function getPrediction(predictionId) {
  const res = await fetch(`${REPLICATE_API_BASE}/predictions/${predictionId}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Replicate getPrediction falló (${res.status}): ${errText}`);
  }

  return res.json();
}

module.exports = { createModelPrediction, getPrediction };
