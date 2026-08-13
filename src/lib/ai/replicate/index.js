const { ImageGenerationProvider } = require('../provider');
const { generateLandscape } = require('./generate');
const { editLandscape } = require('./edit');
const { getPrediction } = require('./client');

const WEBHOOK_URL = process.env.REPLICATE_WEBHOOK_URL; // https://paisajismo.doctanexus.com/api/webhooks/replicate

function mapStatus(replicateStatus) {
  return replicateStatus === 'starting' ? 'starting' : replicateStatus;
}

class ReplicateProvider extends ImageGenerationProvider {
  async generate(input) {
    const result = await generateLandscape({
      referenceImageUrls: input.referenceImageUrls || [],
      prompt: input.prompt,
      quality: input.metadata?.quality || 'standard',
      webhookUrl: WEBHOOK_URL,
    });

    return {
      predictionId: result.predictionId,
      status: mapStatus(result.status),
      _internal: { estimatedCostUsd: result.estimatedCostUsd, creditsCost: result.creditsCost },
    };
  }

  async edit(input) {
    const result = await editLandscape({
      baseImageUrl: input.baseImageUrl,
      additionalReferenceUrls: input.additionalReferenceUrls || [],
      prompt: input.prompt,
      quality: input.metadata?.quality || 'standard',
      webhookUrl: WEBHOOK_URL,
    });

    return {
      predictionId: result.predictionId,
      status: mapStatus(result.status),
      _internal: { estimatedCostUsd: result.estimatedCostUsd, creditsCost: result.creditsCost },
    };
  }

  async getStatus(predictionId) {
    const prediction = await getPrediction(predictionId);
    return {
      status: mapStatus(prediction.status),
      outputUrl: Array.isArray(prediction.output) ? prediction.output[0] : prediction.output,
      errorMessage: prediction.error || undefined,
    };
  }
}

module.exports = { ReplicateProvider };
