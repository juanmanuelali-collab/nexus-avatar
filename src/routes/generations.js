const express = require('express');
const { supabase } = require('../lib/supabaseClient');
const { requireAuth, assertOwnsProject } = require('../lib/auth');
const { buildPrompt } = require('../lib/promptEngine');
const { ReplicateProvider } = require('../lib/ai/replicate');
const modelConfig = require('../lib/ai/modelConfig');
const { checkUserCredits, deductCredits } = require('../lib/credits');
const { positivizeAvoidList } = require('../lib/ai/positivize');
const crypto = require('crypto');

const router = express.Router();
const provider = new ReplicateProvider();

const VALID_CAMERA_DISTANCE = ['wide', 'medium', 'close'];
const VALID_ASPECT_RATIOS = [
  'match_input_image', '1:1', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9', '2:3', '3:2',
];

/**
 * POST /api/projects/:id/generate
 * Genera los 3 conceptos diferenciados de la sección 57 del pedido
 * (Contemporánea / Natural / Premium — ver modelConfig.concepts) en el mismo
 * request, no de a uno. Cada concepto es una "generation" independiente,
 * agrupadas por concept_group_id para mostrarlas juntas en el frontend.
 *
 * No bloquea esperando resultados — dispara las 3 predictions y devuelve un
 * array con los 3 {generation_id, prediction_id, status} de inmediato; cada
 * una resuelve por su propio webhook.
 */
router.post('/projects/:id/generate', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  const {
    elements = [],
    quality = 'standard',
    user_description,
    avoid_text,
    color_palette = [],
    camera_distance,
    depth_of_field = false,
    lighting_mood,
    aspect_ratio,
  } = req.body;

  if (camera_distance && !VALID_CAMERA_DISTANCE.includes(camera_distance)) {
    return res.status(400).json({ error: `camera_distance inválido: ${camera_distance}` });
  }
  if (aspect_ratio && !VALID_ASPECT_RATIOS.includes(aspect_ratio)) {
    return res.status(400).json({ error: `aspect_ratio inválido: ${aspect_ratio}` });
  }
  if (color_palette.length > 3) {
    return res.status(400).json({ error: 'máximo 3 colores en la paleta' });
  }

  try {
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) return res.status(404).json({ error: 'proyecto no encontrado' });
    if (!assertOwnsProject(project, req, res)) return;

    const { data: references } = await supabase
      .from('project_references')
      .select('*')
      .eq('project_id', projectId);

    if (!project.original_image_url && (!references || references.length === 0)) {
      return res.status(400).json({
        error: 'el proyecto no tiene ninguna imagen cargada (ni foto real ni boceto/referencia)',
      });
    }

    const tier = modelConfig.qualityTiers[quality] || modelConfig.qualityTiers.standard;
    const concepts = modelConfig.concepts; // 3 perfiles: Contemporánea / Natural / Premium
    const totalRequiredCredits = tier.creditsCost * concepts.length;

    const { ok: hasCredits, credits: currentCredits } = await checkUserCredits(req.user.id, totalRequiredCredits);
    if (!hasCredits) {
      return res.status(402).json({
        error: `no tenés créditos suficientes — esta generación produce ${concepts.length} conceptos y cuesta ${totalRequiredCredits} créditos en total`,
        credits_available: currentCredits,
        credits_required: totalRequiredCredits,
      });
    }

    const avoidTextPositive = await positivizeAvoidList(avoid_text);
    const conceptGroupId = crypto.randomUUID();

    // Se generan los 3 conceptos en paralelo. Cada uno es independiente: si
    // uno falla, los otros dos pueden seguir su curso normalmente — no todo
    // o nada. Los créditos de un concepto fallido se reintegran solos (misma
    // lógica que ya usa el webhook para generations individuales).
    const results = await Promise.all(
      concepts.map(async (conceptProfile) => {
        const {
          prompt,
          referenceImageUrls,
          transformationType,
          isConceptual,
          negativePromptForRecord,
          aspectRatio,
        } = buildPrompt({
          project,
          elements,
          references: references || [],
          userDescription: user_description,
          avoidTextPositive,
          colorPalette: color_palette,
          cameraDistance: camera_distance,
          depthOfField: depth_of_field,
          lightingMood: lighting_mood,
          aspectRatio: aspect_ratio,
          conceptProfile,
        });

        const { data: generation, error: genError } = await supabase
          .from('generations')
          .insert({
            project_id: projectId,
            user_id: req.user.id,
            prompt,
            negative_prompt: negativePromptForRecord,
            input_image_url: project.original_image_url || null,
            reference_image_urls: referenceImageUrls,
            input_mode: project.input_mode,
            transformation_type: transformationType,
            is_conceptual: isConceptual,
            user_description: user_description || null,
            avoid_text: avoid_text || null,
            avoid_text_positive: avoidTextPositive,
            color_palette,
            camera_distance: camera_distance || null,
            depth_of_field,
            lighting_mood: lighting_mood || null,
            aspect_ratio: aspectRatio,
            resolution: tier.resolution,
            concept_label: conceptProfile.label,
            concept_group_id: conceptGroupId,
            status: 'queued',
            generation_type: 'standard',
          })
          .select()
          .single();

        if (genError) {
          return { concept: conceptProfile.label, error: 'no pudimos registrar este concepto' };
        }

        try {
          const result = await provider.generate({
            referenceImageUrls,
            prompt,
            aspectRatio,
            metadata: { quality, project_id: projectId, generation_id: generation.id },
          });

          await supabase
            .from('generations')
            .update({
              replicate_prediction_id: result.predictionId,
              status: result.status,
              estimated_cost: result._internal?.estimatedCostUsd,
              credits_used: tier.creditsCost,
            })
            .eq('id', generation.id);

          return {
            concept: conceptProfile.label,
            generation_id: generation.id,
            prediction_id: result.predictionId,
            status: result.status,
          };
        } catch (replicateErr) {
          await supabase
            .from('generations')
            .update({ status: 'failed', error_message: replicateErr.message, completed_at: new Date().toISOString() })
            .eq('id', generation.id);
          return { concept: conceptProfile.label, generation_id: generation.id, error: replicateErr.message };
        }
      })
    );

    // Solo se descuentan créditos por los conceptos que SÍ arrancaron bien en Replicate.
    const succeededCount = results.filter((r) => r.prediction_id).length;
    const creditsToDeduct = tier.creditsCost * succeededCount;
    if (creditsToDeduct > 0) await deductCredits(req.user.id, creditsToDeduct);

    res.status(202).json({
      concept_group_id: conceptGroupId,
      concepts: results,
      credits_used: creditsToDeduct,
      credits_remaining: currentCredits - creditsToDeduct,
      avoid_text_applied: Boolean(avoidTextPositive),
      ...(avoid_text && !avoidTextPositive
        ? { warning: 'No pudimos procesar "qué evitar" esta vez — se generó sin esa restricción.' }
        : {}),
    });
  } catch (err) {
    console.error('Error en /generate:', err);
    res.status(500).json({ error: 'no pudimos iniciar la generación' });
  }
});

module.exports = router;
