const { createModelPrediction } = require('./client');
const modelConfig = require('../modelConfig');

/**
 * Edita un render anterior ("hacé la piscina más grande", "sacá la pérgola").
 * El render anterior es la imagen[1]; puede ir acompañado de referencias
 * adicionales si el usuario suma una nueva (ej. "poné una pileta como esta").
 */
async function editLandscape({ baseImageUrl, additionalReferenceUrls = [], prompt, quality = 'standard', webhookUrl }) {
  const modelDef = modelConfig.models[quality];
  if (!modelDef?.slug) {
    throw new Error(`No hay modelo configurado para quality="${quality}". Ver src/lib/ai/modelConfig.js`);
  }

  const input = {
    prompt,
    input_images: [baseImageUrl, ...additionalReferenceUrls].slice(0, modelDef.maxReferenceImages),
  };

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

module.exports = { editLandscape };
