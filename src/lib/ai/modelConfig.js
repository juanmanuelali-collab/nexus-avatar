/**
 * Configuración de modelos. Ver /docs/AI_ARCHITECTURE.md.
 *
 * Modelo: black-forest-labs/flux-2-pro
 * - Modelo oficial de Replicate → se llama por owner/name, sin version hash.
 * - CONFIRMADO con una llamada real (auditoría "70" del pedido): el campo de
 *   multi-imagen es "input_images" (array de URLs). Ya no es una estimación.
 * - NO soporta negative_prompt — todo va en positivo (ver promptEngine.js).
 * - Otros campos confirmados contra una prediction real: resolution,
 *   output_format, output_quality, safety_tolerance, aspect_ratio.
 *
 * Auditoría "69" del pedido (¿el parámetro quality realmente cambia algo?):
 * la versión anterior tenía FLUX_MODEL_SLUG y FLUX_MODEL_SLUG_HQ apuntando al
 * MISMO modelo — "alta calidad" no cambiaba nada salvo cobrar más créditos.
 * Se resuelve usando un único modelo pero variando "resolution" y
 * "output_quality", que sí son parámetros reales que el modelo respeta —
 * más simple de mantener que sostener dos slugs de modelo (flux-2-max queda
 * pendiente de evaluar en un benchmark aparte, sección 67/68 del pedido).
 */
module.exports = {
  provider: process.env.AI_PROVIDER || 'replicate',
  modelSlug: process.env.FLUX_MODEL_SLUG || 'black-forest-labs/flux-2-pro',
  maxReferenceImages: 8,
  supportsNegativePrompt: false,

  qualityTiers: {
    standard: { resolution: '1 MP', outputQuality: 80, creditsCost: 1, estimatedCostUsd: 0.04 },
    highQuality: { resolution: '2 MP', outputQuality: 95, creditsCost: 2, estimatedCostUsd: 0.08 },
  },

  // 3 conceptos diferenciados por request (sección 57 del pedido) — cada uno
  // ajusta el énfasis de estilo/materiales sin perder el estilo base elegido
  // por el usuario. Ver promptEngine.js: buildConceptPrompts().
  concepts: [
    {
      key: 'contemporary',
      label: 'Contemporánea',
      styleEmphasis: 'clean contemporary lines, structured planting, architectural landscape lighting, minimal color palette',
    },
    {
      key: 'natural',
      label: 'Natural',
      styleEmphasis: 'abundant layered vegetation, organic materials, naturalistic planting, softer informal composition',
    },
    {
      key: 'premium',
      label: 'Premium',
      styleEmphasis: 'high-end materials, sophisticated furniture, refined lighting design, elevated finishes throughout',
    },
  ],
};
