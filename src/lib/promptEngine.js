/**
 * PROMPT ENGINE
 * -------------
 * Única fuente autorizada para construir el prompt final que se manda a Replicate.
 * El frontend NUNCA arma ni envía el prompt directamente.
 *
 * v4: suma tres fuentes nuevas de contexto, todas opcionales y sin romper el
 * comportamiento anterior si no vienen:
 *   - Landscape Brief (sección 53) — intención estable del espacio (para qué
 *     se usa, nivel de mantenimiento deseado, qué conservar), vive a nivel
 *     project y se aplica a TODAS las generaciones de ese proyecto.
 *   - Site Analysis (sección 52) — lo que Claude detectó en la foto real al
 *     subirla (arquitectura, vegetación existente, etc.), SIEMPRE presentado
 *     como estimación, nunca como hecho certero.
 *   - Perfil de concepto (sección 57) — cuando se generan 3 conceptos por
 *     request, cada uno inyecta un énfasis de estilo distinto sin perder el
 *     estilo base elegido por el usuario.
 *
 * Se mantiene todo lo anterior: JSON estructurado (recomendado por BFL para
 * flujos de producción), sin negative_prompt real, jerarquía de fuentes
 * visuales, interpretación de bocetos.
 *
 * JERARQUÍA DE FUENTES VISUALES (sección 8.1 / 56 de la spec):
 *   1. Foto real / imagen base       → geometría y arquitectura (innegociable)
 *   2. Boceto / layout                → intención de distribución
 *   3. Referencia de estilo           → lenguaje visual
 *   4. Referencias de elementos       → materiales y objetos específicos
 *   5. Texto del usuario (brief + descripción libre + "qué evitar" positivizado)
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

const MAINTENANCE_LABEL = {
  bajo: 'low-maintenance design: hardy plants, minimal lawn area, simple upkeep',
  medio: 'balanced maintenance design: mix of easy-care and higher-attention plantings',
  alto: 'high-maintenance design acceptable: lush plantings, detailed features, formal upkeep expected',
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

/** Convierte el site_analysis (Claude vision) en una frase de contexto, siempre marcada como estimación. */
function siteAnalysisNote(siteAnalysis) {
  if (!siteAnalysis) return null;
  const facts = [];
  if (siteAnalysis.existing_pool) facts.push('an existing pool');
  if (siteAnalysis.existing_lawn) facts.push('existing lawn area');
  if (siteAnalysis.hardscape_detected) facts.push('existing hardscape/paved surfaces');
  if (siteAnalysis.vegetation_detected) facts.push('existing vegetation');
  if (!facts.length) return null;
  return `Estimated site context (approximate, not certified): the space appears to already have ${facts.join(', ')}. ` +
    `Take this into account when designing, but rely primarily on the actual base image for ground truth.`;
}

/** Landscape Brief (sección 53) → bloque de contexto estable del proyecto. */
function briefNote({ purposeTags = [], maintenanceLevel, keepElements }) {
  const parts = [];
  if (purposeTags.length) parts.push(`Primary intended uses for this space: ${purposeTags.join(', ')}.`);
  if (maintenanceLevel && MAINTENANCE_LABEL[maintenanceLevel]) parts.push(MAINTENANCE_LABEL[maintenanceLevel] + '.');
  if (keepElements?.trim()) parts.push(`The user specifically wants to keep: ${keepElements.trim()}.`);
  return parts.length ? parts.join(' ') : null;
}

/**
 * @param {Object} params
 * @param {Object} params.project - { project_type, style, budget_level, original_image_url, purpose_tags, maintenance_level, keep_elements, site_analysis }
 * @param {string[]} params.elements
 * @param {Array<{reference_type, description?, image_url}>} params.references
 * @param {string} [params.userEditRequest] - para /edit ("hacé la piscina más grande")
 * @param {string} [params.userDescription]
 * @param {string} [params.avoidTextPositive] - ya reescrito en positivo (viene de positivize.js)
 * @param {Array<{hex:string,label:string}>} [params.colorPalette]
 * @param {'wide'|'medium'|'close'} [params.cameraDistance]
 * @param {boolean} [params.depthOfField] - fondo desenfocado, sujeto nítido (estilo foto profesional)
 * @param {string} [params.lightingMood]
 * @param {string} [params.aspectRatio]
 * @param {{key:string,label:string,styleEmphasis:string}} [params.conceptProfile] - uno de modelConfig.concepts
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
  depthOfField,
  lightingMood,
  aspectRatio,
  conceptProfile,
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

  const orderedImages = [];
  if (hasBasePhoto) orderedImages.push({ url: project.original_image_url, role: 'base photo (existing real space, geometry source of truth)' });
  sketchOrLayoutRefs.forEach((r) => orderedImages.push({ url: r.image_url, role: 'sketch/layout (spatial intent)' }));
  styleRefs.forEach((r) =>
    orderedImages.push({ url: r.image_url, role: `${r.reference_type} reference${r.description ? `: ${r.description}` : ''}` })
  );
  const finalImages = orderedImages.slice(0, 8);
  const sketchIndex = finalImages.findIndex((img) => img.role.startsWith('sketch/layout'));

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

  const brief = briefNote({
    purposeTags: project.purpose_tags || [],
    maintenanceLevel: project.maintenance_level,
    keepElements: project.keep_elements,
  });
  if (brief) subjects.push({ type: 'space brief', description: brief });

  const styleBase = `${project.style || 'contemporary'} landscape design, ${project.budget_level || 'medio'} sophistication level (creative/quality variable, not a monetary constraint)`;
  const styleFinal = conceptProfile ? `${styleBase}. Concept variant "${conceptProfile.label}": ${conceptProfile.styleEmphasis}.` : styleBase;

  const cameraObj = {};
  if (cameraDistance) cameraObj.distance = CAMERA_DISTANCE_LABEL[cameraDistance];
  if (depthOfField) cameraObj.depth_of_field = 'shallow depth of field, sharp focus on the main subject, softly blurred background — professional photographic look';

  const promptObject = {
    scene: isConceptual
      ? `Conceptual landscape architecture visualization for a ${project.project_type || 'outdoor space'}. ` +
        `This is a design exploration, not a photo-accurate representation of an existing property — there is no real base photograph.`
      : `Highly photorealistic professional landscape architecture visualization based on the provided existing property photograph (${project.project_type || 'outdoor space'}).`,
    subjects,
    style: styleFinal,
    ...(colorPalette.length
      ? { color_palette: colorPalette.map((c) => `${c.hex}${c.label ? ` (${c.label})` : ''}`) }
      : {}),
    ...(lightingMood ? { lighting: lightingMood } : {}),
    composition: hasBasePhoto
      ? 'Preserve the exact camera position and perspective of the base image.'
      : 'Natural, professional architectural-photography composition.',
    camera: Object.keys(cameraObj).length ? cameraObj : undefined,
  };

  if (hasBasePhoto) {
    promptObject.preserve = 'Keep the existing house architecture, facade, windows, doors, walls, property ' +
      'boundaries, structural elements, camera position, perspective and proportions completely unchanged. ' +
      'Modify only the landscape design elements.';
  }

  const siteNote = siteAnalysisNote(project.site_analysis);
  if (siteNote) promptObject.site_context = siteNote;

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
