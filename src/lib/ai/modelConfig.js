/**
 * Configuración de modelos. Ver /docs/AI_ARCHITECTURE.md.
 *
 * Modelo elegido: black-forest-labs/flux-2-pro
 * - Modelo OFICIAL de Replicate (is_official: true) → se corre contra el endpoint
 *   de modelo (/v1/models/{owner}/{name}/predictions), sin necesidad de fijar un
 *   version hash. Esto es justamente lo que pide la spec ("no hardcodear el modelo
 *   de manera que dependa de una versión obsoleta").
 * - Soporta hasta 8 imágenes de referencia por request, referenciadas por índice
 *   dentro del prompt (ej. "use the pool style from image 3").
 * - IMPORTANTE: NO soporta negative_prompt. BFL indica explícitamente que usar
 *   negative prompts puede producir el efecto contrario (agregar lo que se quiere
 *   evitar). Todas las restricciones deben ir como descripción POSITIVA dentro
 *   del prompt principal — ver src/lib/promptEngine.js.
 * - Límite de tamaño de input: 9 megapixels combinados entre todas las imágenes.
 *
 * TODO antes de la primera prueba real: confirmar el nombre exacto del campo de
 * input para imágenes múltiples contra el schema vivo en
 * https://replicate.com/black-forest-labs/flux-2-pro/api — hay fuentes que
 * difieren entre "input_images" y otros nombres según la versión del modelo.
 * Dejé "input_images" como mejor estimación; validar con una llamada real antes
 * de dar por cerrado el adapter.
 */
module.exports = {
  provider: process.env.AI_PROVIDER || 'replicate',

  models: {
    standard: {
      // Modelo oficial → sin version hash, se llama por owner/name
      slug: process.env.FLUX_MODEL_SLUG || 'black-forest-labs/flux-2-pro',
      supportsNegativePrompt: false,
      maxReferenceImages: 8,
      creditsCost: 1,
    },
    highQuality: {
      slug: process.env.FLUX_MODEL_SLUG_HQ || 'black-forest-labs/flux-2-pro',
      supportsNegativePrompt: false,
      maxReferenceImages: 8,
      creditsCost: 2,
    },
  },

  estimatedCostUsd: {
    standard: 0.05,
    highQuality: 0.05,
  },
};
