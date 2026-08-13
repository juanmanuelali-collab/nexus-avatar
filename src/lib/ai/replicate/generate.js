const { createModelPrediction } = require('./client');
const modelConfig = require('../modelConfig');

/**
 * Genera una propuesta de paisajismo nueva.
 * @param {Object} params
 * @param {string[]} params.referenceImageUrls - ya ordenadas por prioridad (Prompt Engine)
 * @param {string} params.prompt - prompt final ya construido, con TODAS las restricciones
 *   redactadas en positivo (el modelo no soporta negative_prompt)
 * @param {'standard'|'highQuality'} [params.quality]
 * @param {string} params.webhookUrl
 */
async function generateLandscape({ referenceImageUrls = [], prompt, quality = 'standard', webhookUrl }) {
  const modelDef = modelConfig.models[quality];
  if (!modelDef?.slug) {
    throw new Error(`No hay modelo configurado para quality="${quality}". Ver src/lib/ai/modelConfig.js`);
  }

  // TODO: verificar el nombre exacto de este campo contra el schema vivo del
  // modelo antes de la primera prueba real (ver nota en modelConfig.js).
  const input = {
    prompt,
    ...(referenceImageUrls.length > 0 ? { input_images: referenceImageUrls } : {}),
  };
  // negative_prompt NO se envía — flux-2-pro no lo soporta (ver promptEngine.js)

  const prediction = await createModelPrediction({
    modelSlug: modelDef.slug,
    input,
    webhookUrl,
  });

  return {
    predictionId: prediction.id,
    status: prediction.status,
    estimatedCostUsd: modelConfig.estimatedCostUsd[quality],
    creditsCost: modelDef.creditsCost,
  };
}

module.exports = { generateLandscape };
