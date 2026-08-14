const { createModelPrediction } = require('./client');
const modelConfig = require('../modelConfig');

/**
 * Genera una propuesta de paisajismo. input_images, aspect_ratio, resolution
 * y output_format/output_quality están CONFIRMADOS contra una prediction real
 * (auditoría "70" del pedido) — ya no son estimaciones.
 *
 * @param {Object} params
 * @param {string[]} params.referenceImageUrls - ya ordenadas por prioridad (Prompt Engine)
 * @param {string} params.prompt - JSON estructurado (ver promptEngine.js)
 * @param {string} [params.aspectRatio]
 * @param {'standard'|'highQuality'} [params.quality]
 * @param {string} params.webhookUrl
 */
async function generateLandscape({ referenceImageUrls = [], prompt, aspectRatio, quality = 'standard', webhookUrl }) {
  const tier = modelConfig.qualityTiers[quality] || modelConfig.qualityTiers.standard;

  const input = {
    prompt,
    output_format: 'webp',
    output_quality: tier.outputQuality,
    resolution: tier.resolution,
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(referenceImageUrls.length > 0 ? { input_images: referenceImageUrls } : {}),
  };
  // negative_prompt NO se envía — flux-2-pro no lo soporta (ver promptEngine.js)

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
    resolution: tier.resolution,
  };
}

module.exports = { generateLandscape };
