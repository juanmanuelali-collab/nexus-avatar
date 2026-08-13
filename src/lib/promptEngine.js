/**
 * PROMPT ENGINE
 * -------------
 * Única fuente autorizada para construir el prompt final que se manda a Replicate.
 * El frontend NUNCA arma ni envía el prompt directamente.
 *
 * v3: arma el prompt como JSON ESTRUCTURADO en vez de texto libre. BFL
 * recomienda explícitamente este modo para "flujos de producción que
 * requieren estructura consistente" — que es exactamente este caso (un SaaS
 * generando renders repetibles, no exploración creativa suelta). Campos
 * soportados por FLUX.2: scene, subjects, style, color_palette, lighting,
 * mood, composition, camera{angle, distance, lens}.
 *
 * flux-2-pro NO soporta negative_prompt — todas las restricciones van
 * redactadas en positivo, DENTRO del JSON. Nunca se manda un negative_prompt
 * real a la API (se guarda en DB sólo por trazabilidad).
 *
 * JERARQUÍA DE FUENTES VISUALES (sección 8.1 de la spec):
 *   1. Foto real / imagen base       → geometría y arquitectura (innegociable)
 *   2. Boceto / layout                → intención de distribución
 *   3. Referencia de estilo           → lenguaje visual
 *   4. Referencias de elementos       → materiales y objetos específicos
 *   5. Texto del usuario (descripción libre + "qué evitar" positivizado)
 */

const REFERENCE_TYPE_PRIORITY = {
  sketch: 2, layout: 2,
  style: 3, landscape: 3, architecture: 3,
  plant: 4, pool: 4, pergola: 4, deck: 4, lighting: 4, furniture: 4, material: 4, other: 4,
};

const CAMERA_DISTANCE_LABEL = {
  wide: 'wide shot, full scene visible, establishing view',
  medium: 'medium shot, balanced framing of the main area',
  close: 'close-up, focused on a specific corner or feature',
};

function sortReferencesByPriority(references) {
  return [...references].sort(
    (a, b) => (REFERENCE_TYPE_PRIORITY[a.reference_type] || 9) - (REFERENCE_TYPE_PRIORITY[b.reference_type] || 9)
  );
}

function resolveTransformationType({ hasBasePhoto, hasSketchOrLayout, hasStyleReference }) {
  if (hasBasePhoto && hasSketchOrLayout) return { type: 'photo_plus_sketch', conceptual: false };
  if (hasBasePhoto && hasStyleReference) return { type: 'photo_plus_reference', conceptual: false };
  if (hasBasePhoto) return { type: 'photo_to_landscape', conceptual: false };
  if (hasSketchOrLayout) return { type: 'sketch_to_landscape', conceptual: true };
  if (hasStyleReference) return { type: 'reference_to_landscape', conceptual: false };
  return { type: 'concept_to_landscape', conceptual: true };
}

function sketchInterpretationNote(imageIndex) {
  return `Image ${imageIndex} is a hand-drawn sketch or layout plan, not a photograph. Interpret its lines, ` +
    `shapes and written annotations as spatial intent (pool, deck, pergola, planting beds, paths). Convert ` +
    `those conceptual marks into physically plausible, properly proportioned real-world materials and ` +
    `structures. The final image must read as a finished photorealistic scene — translate the sketch fully, ` +
    `do not reproduce its lines or handwriting. Keep proportions grounded in typical residential landscaping ` +
    `dimensions; do not invent exact measurements the sketch doesn't imply.`;
}

/**
 * @param {Object} params
 * @param {Object} params.project - { project_type, style, budget_level, original_image_url, primary_input_url }
 * @param {string[]} params.elements
 * @param {Array<{reference_type, description?, image_url}>} params.references
 * @param {string} [params.userEditRequest] - para /edit ("hacé la piscina más grande")
 * @param {string} [params.userDescription] - descripción libre del usuario, en sus palabras
 * @param {string} [params.avoidTextPositive] - ya reescrito en positivo (viene de positivize.js)
 * @param {Array<{hex:string,label:string}>} [params.colorPalette]
 * @param {'wide'|'medium'|'close'} [params.cameraDistance]
 * @param {string} [params.lightingMood] - ej. "atardecer dorado", "mañana luminosa"
 * @param {string} [params.aspectRatio] - se devuelve tal cual para pasarlo a Replicate
 */
function buildPrompt({
  project,
  elements = [],
  references = [],
  userEditRequest,
  userDescription,
  avoidTextPositive,
  colorPalette = [],
  cameraDistance,
  lightingMood,
  aspectRatio,
}) {
  const hasBasePhoto = Boolean(project.original_image_url);
  const sortedRefs = sortReferencesByPriority(references);
  const sketchOrLayoutRefs = sortedRefs.filter((r) => ['sketch', 'layout'].includes(r.reference_type));
  const styleRefs = sortedRefs.filter((r) => !['sketch', 'layout'].includes(r.reference_type));

  const { type: transformationType, conceptual: isConceptual } = resolveTransformationType({
    hasBasePhoto,
    hasSketchOrLayout: sketchOrLayoutRefs.length > 0,
    hasStyleReference: styleRefs.length > 0,
  });

  // Orden de imágenes → índices que el JSON va a referenciar explícitamente (image 1, image 2...)
  const orderedImages = [];
  if (hasBasePhoto) orderedImages.push({ url: project.original_image_url, role: 'base photo (existing real space, geometry source of truth)' });
  sketchOrLayoutRefs.forEach((r) => orderedImages.push({ url: r.image_url, role: 'sketch/layout (spatial intent)' }));
  styleRefs.forEach((r) =>
    orderedImages.push({ url: r.image_url, role: `${r.reference_type} reference${r.description ? `: ${r.description}` : ''}` })
  );
  const finalImages = orderedImages.slice(0, 8);
  const sketchIndex = finalImages.findIndex((img) => img.role.startsWith('sketch/layout'));

  // ---- Construcción del JSON estructurado ----
  const subjects = [];

  subjects.push({
    type: 'landscape design',
    description: userEditRequest
      ? `Modify only: ${userEditRequest}. Keep every other existing element exactly as-is.`
      : `Design the following elements: ${elements.join(', ') || 'a complete landscape design'}.`,
  });

  if (userDescription?.trim()) {
    subjects.push({ type: 'user intent', description: userDescription.trim() });
  }

  const promptObject = {
    scene: isConceptual
      ? `Conceptual landscape architecture visualization for a ${project.project_type || 'outdoor space'}. ` +
        `This is a design exploration, not a photo-accurate representation of an existing property — there is no real base photograph.`
      : `Highly photorealistic professional landscape architecture visualization based on the provided existing property photograph (${project.project_type || 'outdoor space'}).`,
    subjects,
    style: `${project.style || 'contemporary'} landscape design, ${project.budget_level || 'medio'} sophistication level (creative/quality variable, not a monetary constraint)`,
    ...(colorPalette.length
      ? { color_palette: colorPalette.map((c) => `${c.hex}${c.label ? ` (${c.label})` : ''}`) }
      : {}),
    ...(lightingMood ? { lighting: lightingMood } : {}),
    composition: hasBasePhoto
      ? 'Preserve the exact camera position and perspective of the base image.'
      : 'Natural, professional architectural-photography composition.',
    camera: cameraDistance ? { distance: CAMERA_DISTANCE_LABEL[cameraDistance] } : undefined,
  };

  if (hasBasePhoto) {
    promptObject.preserve = 'Keep the existing house architecture, facade, windows, doors, walls, property ' +
      'boundaries, structural elements, camera position, perspective and proportions completely unchanged. ' +
      'Modify only the landscape design elements.';
  }

  if (sketchIndex >= 0) {
    promptObject.sketch_interpretation = sketchInterpretationNote(sketchIndex + 1);
  }

  if (avoidTextPositive?.trim()) {
    promptObject.additional_requirements = avoidTextPositive.trim();
  }

  promptObject.realism = 'Maintain realistic scale, perspective, shadows, reflections, materials and lighting. ' +
    'Professional architectural landscape photography, physically accurate lighting, extremely realistic.';

  promptObject.constraints = 'Maintain the exact same building, walls, windows, doors, roof, camera angle and ' +
    'perspective as the base image at all times if one is provided. Use only realistic, physically plausible ' +
    'vegetation, structures and proportions grounded in the real scale of the space.';

  // JSON.stringify se encarga de omitir undefined (camera si no hay cameraDistance)
  const prompt = JSON.stringify(promptObject, null, 2);

  const negativePromptForRecord = [
    'Do not alter the existing building, walls, windows, doors or roof',
    'Do not change the camera angle or perspective',
    'Do not distort the property or change its dimensions',
    'Do not introduce unrealistic vegetation or floating/impossible objects',
    'Do not reproduce sketch lines or handwriting in the final render',
  ].join('. ') + '.';

  return {
    prompt,
    negativePromptForRecord,
    referenceImageUrls: finalImages.map((img) => img.url),
    transformationType,
    isConceptual,
    aspectRatio: aspectRatio || (hasBasePhoto ? 'match_input_image' : '4:3'),
  };
}

module.exports = { buildPrompt };
