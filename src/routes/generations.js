const express = require('express');
const { supabase } = require('../lib/supabaseClient');
const { requireAuth, assertOwnsProject } = require('../lib/auth');
const { buildPrompt } = require('../lib/promptEngine');
const { ReplicateProvider } = require('../lib/ai/replicate');
const modelConfig = require('../lib/ai/modelConfig');
const { checkUserCredits, deductCredits } = require('../lib/credits');

const router = express.Router();
const provider = new ReplicateProvider();

/**
 * POST /api/projects/:id/generate
 * No bloquea esperando el resultado — dispara la prediction y devuelve
 * generation_id + prediction_id + status="starting" de inmediato.
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

    const requiredCredits = modelConfig.models[quality]?.creditsCost || 1;
    const { ok: hasCredits, credits: currentCredits } = await checkUserCredits(req.user.id, requiredCredits);
    if (!hasCredits) {
      return res.status(402).json({
        error: 'no tenés créditos suficientes para esta generación',
        credits_available: currentCredits,
        credits_required: requiredCredits,
      });
    }

    const { prompt, referenceImageUrls, transformationType, isConceptual, negativePromptForRecord } = buildPrompt({
      project,
      elements,
      references: references || [],
    });

    const { data: generation, error: genError } = await supabase
      .from('generations')
      .insert({
        project_id: projectId,
        user_id: req.user.id,
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

    let result;
    try {
      result = await provider.generate({
        referenceImageUrls,
        prompt,
        metadata: { quality, project_id: projectId, generation_id: generation.id },
      });
    } catch (replicateErr) {
      // No se descontaron créditos porque la prediction nunca se creó — no hay nada que reintegrar.
      await supabase
        .from('generations')
        .update({ status: 'failed', error_message: replicateErr.message, completed_at: new Date().toISOString() })
        .eq('id', generation.id);
      throw replicateErr;
    }

    // Recién ahora, con la prediction ya aceptada por Replicate, se descuenta.
    await deductCredits(req.user.id, requiredCredits);

    await supabase
      .from('generations')
      .update({
        replicate_prediction_id: result.predictionId,
        status: result.status,
        estimated_cost: result._internal?.estimatedCostUsd,
        credits_used: requiredCredits,
      })
      .eq('id', generation.id);

    res.status(202).json({
      generation_id: generation.id,
      prediction_id: result.predictionId,
      status: result.status,
      is_conceptual: isConceptual,
      credits_remaining: currentCredits - requiredCredits,
    });
  } catch (err) {
    console.error('Error en /generate:', err);
    res.status(500).json({ error: 'no pudimos iniciar la generación' });
  }
});

module.exports = router;
