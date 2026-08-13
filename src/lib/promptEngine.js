/**
 * PROMPT ENGINE
 * -------------
 * Única fuente autorizada para construir el prompt final que se manda a Replicate.
 * El frontend NUNCA arma ni envía el prompt directamente.
 *
 * CAMBIO CLAVE vs. v1: flux-2-pro NO soporta negative_prompt (confirmado en la
 * documentación oficial — usar negative prompts puede producir el efecto
 * contrario). Por eso ya no se genera un negative_prompt para mandarle al modelo;
 * las restricciones se redactan en positivo y se insertan dentro del prompt
 * principal. Se sigue guardando un "negative_prompt" en la base de datos por
 * trazabilidad/documentación, pero NUNCA se envía como campo a la API.
 *
 * JERARQUÍA DE FUENTES VISUALES (sección 8.1 de la spec):
 *   1. Foto real / imagen base       → geometría y arquitectura (innegociable)
 *   2. Boceto / layout                → intención de distribución
 *   3. Referencia de estilo           → lenguaje visual
 *   4. Referencias de elementos       → materiales y objetos específicos
 *   5. Texto del usuario              → preferencias y restricciones
 *
 * Esta jerarquía determina el ORDEN en que las imágenes se mandan a Replicate
 * (índice 1, 2, 3...) y cómo el prompt les asigna un rol explícito por índice
 * ("image 2 shows the desired layout — follow its spatial distribution").
 */

const REFERENCE_TYPE_PRIORITY = {
  sketch: 2,
  layout: 2,
  style: 3,
  landscape: 3,
  architecture: 3,
  plant: 4,
  pool: 4,
  pergola: 4,
  deck: 4,
  lighting: 4,
  furniture: 4,
  material: 4,
  other: 4,
};

const PRESERVE_BLOCK = `Preserve exactly the existing house architecture, facade, windows, doors, walls,
property boundaries, existing structural elements, camera position, perspective, proportions
and architectural geometry from the base image. Keep the building completely unchanged.`;

// Reescritas en positivo — flux-2-pro no soporta negative_prompt.
const POSITIVE_RESTRICTIONS = `Maintain the exact same building, walls, windows, doors, roof, camera angle
and perspective as the base image at all times. Keep the property boundaries and dimensions
identical to the base image. Use only realistic, physically plausible vegetation, structures
and proportions grounded in the actual scale of the space. Keep every object properly supported
and resting on real surfaces.`;

const REALISM_BLOCK = `Maintain realistic scale, perspective, shadows, reflections, materials and lighting.
The final result must look like a professional architectural landscape visualization photographed
from the same camera position. Photorealistic, high-end landscape architecture photography,
physically accurate lighting, extremely realistic.`;

function sortReferencesByPriority(references) {
  return [...references].sort(
    (a, b) => (REFERENCE_TYPE_PRIORITY[a.reference_type] || 9) - (REFERENCE_TYPE_PRIORITY[b.reference_type] || 9)
  );
}

/**
 * Determina transformation_type e is_conceptual según qué material subió el usuario.
 * @param {Object} project - { input_mode }
 * @param {boolean} hasBasePhoto
 * @param {boolean} hasSketchOrLayout
 * @param {boolean} hasStyleReference
 */
function resolveTransformationType({ hasBasePhoto, hasSketchOrLayout, hasStyleReference }) {
  if (hasBasePhoto && hasSketchOrLayout) return { type: 'photo_plus_sketch', conceptual: false };
  if (hasBasePhoto && hasStyleReference) return { type: 'photo_plus_reference', conceptual: false };
  if (hasBasePhoto) return { type: 'photo_to_landscape', conceptual: false };
  if (hasSketchOrLayout) return { type: 'sketch_to_landscape', conceptual: true };
  if (hasStyleReference) return { type: 'reference_to_landscape', conceptual: false };
  return { type: 'concept_to_landscape', conceptual: true };
}

/**
 * Instrucciones específicas para cuando hay boceto/layout en juego (Caso A y Caso C).
 * No basta con "usar" la imagen del boceto — hay que decirle explícitamente al
 * modelo qué hacer con las líneas y anotaciones de un dibujo a mano.
 */
function sketchInterpretationBlock(sketchImageIndex) {
  return `Image ${sketchImageIndex} is a hand-drawn sketch or layout plan, not a photograph. Interpret its
lines, shapes and any written annotations as spatial intent: identify which zones correspond to
pool, deck, pergola, planting beds, paths and other elements. Convert those conceptual marks into
physically plausible, properly proportioned real-world objects and materials. Do not reproduce the
sketch lines, arrows or handwriting themselves in the output — the final image must read as a
finished photorealistic scene, with the sketch fully translated into real materials, vegetation
and structures. Keep proportions reasonable and grounded in typical real-world dimensions for
residential landscaping; do not invent exact measurements that are not implied by the sketch.`;
}

/**
 * @param {Object} params
 * @param {Object} params.project - { project_type, style, budget_level, input_mode, original_image_url, primary_input_url }
 * @param {string[]} params.elements
 * @param {Array<{reference_type: string, description?: string, image_url: string}>} params.references
 * @param {string} [params.userEditRequest] - para el flujo de edición ("hacé la piscina más grande")
 */
function buildPrompt({ project, elements = [], references = [], userEditRequest }) {
  const hasBasePhoto = Boolean(project.original_image_url);
  const sortedRefs = sortReferencesByPriority(references);
  const sketchOrLayoutRefs = sortedRefs.filter((r) => ['sketch', 'layout'].includes(r.reference_type));
  const styleRefs = sortedRefs.filter((r) => !['sketch', 'layout'].includes(r.reference_type));

  const { type: transformationType, conceptual: isConceptual } = resolveTransformationType({
    hasBasePhoto,
    hasSketchOrLayout: sketchOrLayoutRefs.length > 0,
    hasStyleReference: styleRefs.length > 0,
  });

  // Orden final de imágenes que se mandan a Replicate, según jerarquía 1→4.
  // Máximo 8 (límite del modelo) — si hay más referencias, se recortan las de
  // menor prioridad (element refs) antes que las estructurales.
  const orderedImages = [];
  if (hasBasePhoto) orderedImages.push({ url: project.original_image_url, role: 'base photo (real space)' });
  else if (project.primary_input_url && (sketchOrLayoutRefs[0]?.image_url === project.primary_input_url)) {
    // el primary_input_url ya está contemplado en sketchOrLayoutRefs si corresponde
  }
  sketchOrLayoutRefs.forEach((r) => orderedImages.push({ url: r.image_url, role: 'sketch/layout' }));
  styleRefs.forEach((r) =>
    orderedImages.push({ url: r.image_url, role: `${r.reference_type} reference${r.description ? `: ${r.description}` : ''}` })
  );
  const finalImages = orderedImages.slice(0, 8);

  // Bloque que le explica al modelo qué es cada índice de imagen.
  const imageRolesBlock = finalImages.length
    ? finalImages
        .map((img, i) => `Image ${i + 1}: ${img.role}.`)
        .join(' ')
    : '';

  const contextBlock = isConceptual
    ? `Create a highly photorealistic professional landscape architecture concept visualization
for a ${project.project_type || 'outdoor space'}. This is a CONCEPTUAL design exploration, not a
photo-accurate representation of an existing property — there is no real base photograph.`
    : `Create a highly photorealistic professional landscape architecture visualization based on the
provided existing property photograph (${project.project_type || 'outdoor space'}).`;

  const preservationBlock = hasBasePhoto ? PRESERVE_BLOCK : '';

  const sketchBlock = sketchOrLayoutRefs.length
    ? sketchInterpretationBlock(
        finalImages.findIndex((img) => img.role === 'sketch/layout') + 1
      )
    : '';

  const interventionBlock = userEditRequest
    ? `MODIFY ONLY: ${userEditRequest}. Keep every other element of the current design exactly as-is.`
    : `${hasBasePhoto ? 'MODIFY ONLY THE LANDSCAPE DESIGN. ' : ''}Design the following elements: ${
        elements.join(', ') || 'a complete landscape design'
      }.`;

  const styleBlock = `Style: ${project.style || 'contemporary'}. Quality/creative level: ${
    project.budget_level || 'medio'
  } — treat this as a design sophistication variable, not a monetary constraint.`;

  const finalPrompt = [
    imageRolesBlock,
    contextBlock,
    preservationBlock,
    sketchBlock,
    interventionBlock,
    styleBlock,
    POSITIVE_RESTRICTIONS,
    REALISM_BLOCK,
  ]
    .filter(Boolean)
    .join('\n\n');

  // negative_prompt se guarda para trazabilidad en DB pero NUNCA se manda a Replicate.
  const negativePromptForRecord = [
    'Do not alter the existing building, walls, windows, doors or roof',
    'Do not change the camera angle or perspective',
    'Do not distort the property or change its dimensions',
    'Do not introduce unrealistic vegetation or floating/impossible objects',
    'Do not reproduce sketch lines or handwriting in the final render',
  ].join('. ') + '.';

  return {
    prompt: finalPrompt,
    negativePromptForRecord,
    referenceImageUrls: finalImages.map((img) => img.url),
    transformationType,
    isConceptual,
  };
}

module.exports = { buildPrompt };
