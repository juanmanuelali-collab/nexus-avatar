/**
 * PROMPT ENGINE
 * -------------
 * Única fuente autorizada para construir el prompt final que se manda a Replicate.
 * El frontend NUNCA arma ni envía el prompt directamente.
 *
 * v5: incorpora la primera tanda de la spec ampliada de inputs/lógica de diseño:
 *   - Categoría + sector del proyecto (contexto, no cambia qué se preserva)
 *   - Elementos a conservar / a NO modificar como listas ESTRUCTURADAS
 *     (checkboxes) en vez de solo texto libre — instrucciones mucho más
 *     explícitas y verificables que antes
 *   - Ubicación (contexto de diseño, sección 7)
 *   - Nivel de intervención (0-100, sección 22) — controla cuánto puede
 *     cambiar el espacio, IMPORTANTE: nunca afloja la preservación
 *     arquitectónica, que es siempre innegociable independientemente del nivel
 *   - Criterios de vegetación (sección 13), por generación
 *
 * Se mantiene todo lo anterior: JSON estructurado, sin negative_prompt real,
 * jerarquía de fuentes visuales, interpretación de bocetos, Site Analysis,
 * Landscape Brief, perfiles de concepto.
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

const CATEGORY_LABEL = {
  residencial: 'residential property',
  comercial: 'commercial / hospitality property',
  rural: 'rural property',
  especifico: 'specific outdoor space',
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

  const parts = [];
  if (facts.length) {
    parts.push(`Estimated site context (approximate, not certified): the space appears to already have ${facts.join(', ')}.`);
  }
  if (siteAnalysis.materials_detected?.length) {
    parts.push(`Existing materials detected: ${siteAnalysis.materials_detected.join(', ')}.`);
  }
  if (siteAnalysis.problems_detected?.length) {
    parts.push(`Visible issues to address in the redesign: ${siteAnalysis.problems_detected.join(', ')}.`);
  }
  if (siteAnalysis.intervention_zones?.length) {
    parts.push(`Areas with the most potential for improvement: ${siteAnalysis.intervention_zones.join(', ')}.`);
  }
  if (!parts.length) return null;
  parts.push('Take this into account when designing, but rely primarily on the actual base image for ground truth.');
  return parts.join(' ');
}

/** Landscape Brief (sección 53) → bloque de contexto estable del proyecto. */
const SUN_LABEL = { pleno_sol: 'full sun exposure most of the day', parcial: 'partial sun/shade exposure', sombra: 'predominantly shaded' };
const ORIENTATION_LABEL = { N: 'north-facing', NE: 'northeast-facing', E: 'east-facing', SE: 'southeast-facing', S: 'south-facing', SO: 'southwest-facing', O: 'west-facing', NO: 'northwest-facing' };
const SOIL_LABEL = { arcilloso: 'clay soil', arenoso: 'sandy soil', franco: 'loamy soil' };
const DRAINAGE_LABEL = { bien: 'well-drained', regular: 'moderately drained', mal: 'poorly drained (water tends to pool)' };

function briefNote({ purposeTags = [], maintenanceLevel, keepElements, location, sunExposure, orientation, soilType, drainage }) {
  const parts = [];
  if (purposeTags.length) parts.push(`Primary intended uses for this space: ${purposeTags.join(', ')}.`);
  if (maintenanceLevel && MAINTENANCE_LABEL[maintenanceLevel]) parts.push(MAINTENANCE_LABEL[maintenanceLevel] + '.');
  if (keepElements?.trim()) parts.push(`Additional context on what to keep: ${keepElements.trim()}.`);
  if (location?.trim()) parts.push(`Project location: ${location.trim()} — consider regionally appropriate vegetation and materials for this context.`);

  // Condiciones del sitio (sección 4.4 del analisis externo) -- todas opcionales,
  // "no_se" o ausentes se omiten en vez de inventar un valor.
  const siteFacts = [];
  if (sunExposure && SUN_LABEL[sunExposure]) siteFacts.push(SUN_LABEL[sunExposure]);
  if (orientation && ORIENTATION_LABEL[orientation]) siteFacts.push(ORIENTATION_LABEL[orientation]);
  if (soilType && SOIL_LABEL[soilType]) siteFacts.push(SOIL_LABEL[soilType]);
  if (drainage && DRAINAGE_LABEL[drainage]) siteFacts.push(DRAINAGE_LABEL[drainage]);
  if (siteFacts.length) parts.push(`Site conditions: ${siteFacts.join(', ')} — choose vegetation and materials appropriate for these conditions.`);

  return parts.length ? parts.join(' ') : null;
}

/** Nivel de intervención (0-100, sección 22) → descripción del alcance del cambio. NUNCA afloja la preservación arquitectónica. */
function interventionLabel(level) {
  const n = typeof level === 'number' ? level : 60;
  if (n <= 25) return 'Minimal intervention: light refresh and cleanup of the existing landscape, preserve most current elements, subtle improvements only.';
  if (n <= 50) return 'Moderate intervention: meaningful landscape renovation while keeping the overall existing layout and several current elements.';
  if (n <= 75) return 'Significant transformation: substantial landscape redesign, most vegetation and hardscape elements can change.';
  return 'Complete landscape transformation: fully redesign the landscape from the ground up, maximum creative freedom for vegetation, materials and layout.';
}

/**
 * @param {Object} params
 * @param {Object} params.project
 * @param {string[]} params.elements
 * @param {Array<Object>} params.references
 * @param {string} [params.userEditRequest]
 * @param {string} [params.userDescription]
 * @param {string} [params.avoidTextPositive]
 * @param {Array<Object>} [params.colorPalette]
 * @param {string} [params.cameraDistance]
 * @param {boolean} [params.depthOfField]
 * @param {string} [params.lightingMood]
 * @param {string} [params.aspectRatio]
 * @param {number} [params.interventionLevel]
 * @param {string[]} [params.vegetationCriteria]
 * @param {Object} [params.conceptProfile]
 */
function buildPrompt(params) {
  const {
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
    interventionLevel,
    vegetationCriteria = [],
    conceptProfile,
  } = params;

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
  if (vegetationCriteria.length) {
    subjects.push({ type: 'vegetation criteria', description: `Prioritize vegetation that is: ${vegetationCriteria.join(', ')}.` });
  }

  const brief = briefNote({
    purposeTags: project.purpose_tags || [],
    maintenanceLevel: project.maintenance_level,
    keepElements: project.keep_elements,
    location: project.location,
    sunExposure: project.sun_exposure,
    orientation: project.orientation,
    soilType: project.soil_type,
    drainage: project.drainage,
  });
  if (brief) subjects.push({ type: 'space brief', description: brief });

  const styleBase = `${project.style || 'contemporary'} landscape design, ${project.budget_level || 'medio'} sophistication level (creative/quality variable, not a monetary constraint)`;
  const styleFinal = conceptProfile ? `${styleBase}. Concept variant "${conceptProfile.label}": ${conceptProfile.styleEmphasis}.` : styleBase;

  const cameraObj = {};
  if (cameraDistance) cameraObj.distance = CAMERA_DISTANCE_LABEL[cameraDistance];
  if (depthOfField) cameraObj.depth_of_field = 'shallow depth of field, sharp focus on the main subject, softly blurred background — professional photographic look';

  const projectContext = [
    project.project_category ? CATEGORY_LABEL[project.project_category] : null,
    project.project_type,
    project.sector ? `sector: ${project.sector}` : null,
  ].filter(Boolean).join(', ') || (project.project_type || 'outdoor space');

  const promptObject = {
    scene: isConceptual
      ? `Conceptual landscape architecture visualization for a ${projectContext}. ` +
        `This is a design exploration, not a photo-accurate representation of an existing property — there is no real base photograph.`
      : `Highly photorealistic professional landscape architecture visualization based on the provided existing property photograph (${projectContext}).`,
    subjects,
    style: styleFinal,
    ...(colorPalette.length
      ? { color_palette: colorPalette.map((c) => `${c.hex}${c.label ? ` (${c.label})` : ''}`) }
      : {}),
    ...(lightingMood ? { lighting: lightingMood } : {}),
    intervention: interventionLabel(interventionLevel),
    composition: hasBasePhoto
      ? 'Preserve the exact camera position and perspective of the base image.'
      : 'Natural, professional architectural-photography composition.',
    camera: Object.keys(cameraObj).length ? cameraObj : undefined,
  };

  if (hasBasePhoto) {
    promptObject.preserve = 'Keep the existing house architecture, facade, windows, doors, walls, property ' +
      'boundaries, structural elements, camera position, perspective and proportions completely unchanged. ' +
      'The exact number, size, shape and position of every window and door must match the base image precisely ' +
      '— do not add, remove, resize, or reposition any opening or structural element. The building footprint, ' +
      'height and overall dimensions must remain identical to the base image. Modify only the landscape design ' +
      'elements around the building, never the building itself. This preservation rule is absolute and does not ' +
      'change regardless of the intervention level requested for the landscape.';
  }

  const keepList = project.keep_elements_list || [];
  if (keepList.length) {
    promptObject.elements_to_keep = `The following existing elements must be preserved exactly as they appear in the base image: ${keepList.join(', ')}.`;
  }

  const doNotModifyList = project.do_not_modify || [];
  if (doNotModifyList.length) {
    promptObject.do_not_modify = `Absolutely do not alter, move, remove, resize or reinterpret the following, under any circumstances: ${doNotModifyList.join(', ')}. These must remain pixel-for-pixel consistent with the base image in concept and appearance.`;
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
    'perspective as the base image at all times if one is provided, with identical count, size and placement of ' +
    'every architectural element — do not invent, duplicate, remove or resize any window, door, column or ' +
    'structural feature that exists in the base image. Use only realistic, physically plausible vegetation, ' +
    'structures and proportions grounded in the real scale of the space.';

  const prompt = JSON.stringify(promptObject, null, 2);

  const negativePromptForRecord = [
    'Do not alter the existing building, walls, windows, doors or roof',
    'Do not change the camera angle or perspective',
    'Do not distort the property or change its dimensions',
    'Do not introduce unrealistic vegetation or floating/impossible objects',
    'Do not reproduce sketch lines or handwriting in the final render',
    ...(doNotModifyList.length ? [`Do not modify: ${doNotModifyList.join(', ')}`] : []),
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
