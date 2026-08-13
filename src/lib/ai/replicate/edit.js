const { createModelPrediction } = require('./client');
const modelConfig = require('../modelConfig');

/**
 * Edita un render anterior ("hacé la piscina más grande", "sacá la pérgola").
 * El render anterior es la imagen[1]; puede ir acompañado de referencias
 * adicionales si el usuario suma una nueva (ej. "poné una pileta como esta").
 */
async function editLandscape({ baseImageUrl, additionalReferenceUrls = [], prompt, quality = 'standard', webhookUrl }) {
  const tier = modelConfig.qualityTiers[quality] || modelConfig.qualityTiers.standard;

  const input = {
    prompt,
    output_format: 'webp',
    output_quality: tier.outputQuality,
    resolution: tier.resolution,
    input_images: [baseImageUrl, ...additionalReferenceUrls].slice(0, modelConfig.maxReferenceImages),
  };

  const prediction = await createModelPrediction({
    modelSlug: modelConfig.modelSlug,
    input,
    webhookUrl,
  });

  return {
    predictionId: prediction.id,
    status: prediction.status,
    estimatedCostUsd: tier.estimatedCostUsd,
    creditsCost: tier.creditsCost,
  };
}

module.exports = { editLandscape };
