const express = require('express');
const { supabase } = require('../lib/supabaseClient');
const { buildPrompt } = require('../lib/promptEngine');
const { ReplicateProvider } = require('../lib/ai/replicate');

const router = express.Router();
const provider = new ReplicateProvider();

// TODO: middleware de auth real (validar JWT de Supabase, adjuntar req.user)
async function requireAuth(req, res, next) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'no autenticado' });
  next();
}

/**
 * POST /api/projects/:id/generate
 * No bloquea esperando el resultado — dispara la prediction y devuelve
 * generation_id + prediction_id + status="starting" de inmediato.
 *
 * A diferencia de la v1, YA NO exige original_image_url: un proyecto con
 * input_mode = sketch/reference/concept puede generar sin foto real, la
 * generation queda marcada is_conceptual = true (sección 8.1 de la spec).
 */
router.post('/projects/:id/generate', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  const { elements = [], quality = 'standard' } = req.body;

  try {
    const { data: project, error: projectError } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (projectError || !project) return res.status(404).json({ error: 'proyecto no encontrado' });

    const { data: references } = await supabase
      .from('project_references')
      .select('*')
      .eq('project_id', projectId);

    // Si el proyecto no tiene NINGUNA imagen (ni foto ni referencia), no hay nada
    // que generar — a diferencia de v1, esto ya no depende sólo de original_image_url.
    if (!project.original_image_url && (!references || references.length === 0)) {
      return res.status(400).json({
        error: 'el proyecto no tiene ninguna imagen cargada (ni foto real ni boceto/referencia)',
      });
    }

    // TODO: checkUserCredits(project.user_id) antes de seguir — cortar acá si no alcanzan.

    const { prompt, referenceImageUrls, transformationType, isConceptual, negativePromptForRecord } = buildPrompt({
      project,
      elements,
      references: references || [],
    });

    const { data: generation, error: genError } = await supabase
      .from('generations')
      .insert({
        project_id: projectId,
        user_id: project.user_id,
        prompt,
        negative_prompt: negativePromptForRecord, // solo trazabilidad, NO se manda a Replicate
        input_image_url: project.original_image_url || null,
        reference_image_urls: referenceImageUrls,
        input_mode: project.input_mode,
        transformation_type: transformationType,
        is_conceptual: isConceptual,
        status: 'queued',
        generation_type: 'standard',
      })
      .select()
      .single();

    if (genError) throw genError;

    const result = await provider.generate({
      referenceImageUrls,
      prompt,
      metadata: { quality, project_id: projectId, generation_id: generation.id },
    });

    await supabase
      .from('generations')
      .update({
        replicate_prediction_id: result.predictionId,
        status: result.status,
        estimated_cost: result._internal?.estimatedCostUsd,
      })
      .eq('id', generation.id);

    res.status(202).json({
      generation_id: generation.id,
      prediction_id: result.predictionId,
      status: result.status,
      is_conceptual: isConceptual,
    });
  } catch (err) {
    console.error('Error en /generate:', err);
    res.status(500).json({ error: 'no pudimos iniciar la generación' });
  }
});

module.exports = router;
