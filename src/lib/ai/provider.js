/**
 * AI_MODEL_PROVIDER
 * ------------------
 * Interfaz que debe implementar cualquier proveedor de generación de imágenes.
 * El resto de la aplicación (rutas, prompt engine, webhook) SOLO habla contra
 * esta interfaz. Nunca debe llamar directamente a Replicate, Fal, OpenAI, etc.
 *
 * Esto permite cambiar de modelo (o incluso de proveedor completo) sin tocar
 * el resto de la app — sólo se cambia qué implementación se instancia acá abajo.
 *
 * @typedef {Object} GenerationInput
 * @property {string} inputImageUrl - Foto original del espacio (obligatoria, base del image-to-image)
 * @property {string[]} [referenceImageUrls] - Imágenes de referencia con peso estructural (ej. bocetos)
 * @property {string} prompt - Prompt final ya construido por el Prompt Engine
 * @property {string} [negativePrompt]
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} [seed]
 * @property {Object} [metadata] - project_id, generation_id, etc. para logging/correlación

 * @typedef {Object} EditInput
 * @property {string} baseImageUrl - Render anterior a editar (se usa como nueva imagen de referencia)
 * @property {string} prompt
 * @property {string} [negativePrompt]
 * @property {Object} [metadata]

 * @typedef {Object} GenerationResult
 * @property {string} predictionId - ID externo del proveedor (ej. replicate_prediction_id)
 * @property {'queued'|'starting'|'processing'|'succeeded'|'failed'|'canceled'} status
 * @property {string} [outputUrl] - Sólo si el proveedor devuelve resultado sync (no es el caso de Replicate)
 * @property {string} [errorMessage]

 * @typedef {Object} GenerationStatus
 * @property {'queued'|'starting'|'processing'|'succeeded'|'failed'|'canceled'} status
 * @property {string} [outputUrl]
 * @property {string} [errorMessage]
 */

class ImageGenerationProvider {
  /** @param {GenerationInput} input @returns {Promise<GenerationResult>} */
  async generate(input) {
    throw new Error('generate() no implementado por el provider');
  }

  /** @param {EditInput} input @returns {Promise<GenerationResult>} */
  async edit(input) {
    throw new Error('edit() no implementado por el provider');
  }

  /** @param {string} predictionId @returns {Promise<GenerationStatus>} */
  async getStatus(predictionId) {
    throw new Error('getStatus() no implementado por el provider');
  }
}

module.exports = { ImageGenerationProvider };
