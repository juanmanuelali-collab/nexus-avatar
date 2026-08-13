const express = require('express');
const { verifyReplicateWebhook } = require('../lib/ai/replicate/verify');
const { supabase } = require('../lib/supabaseClient');
const { downloadAndStoreImage } = require('../lib/storage');
const { refundCredits } = require('../lib/credits');

const router = express.Router();

// IMPORTANTE: esta ruta necesita el body RAW (Buffer), no JSON parseado —
// la firma HMAC se calcula sobre el string exacto recibido. Se monta con
// express.raw() en server.js SOLO para este path.
router.post('/replicate', async (req, res) => {
  const rawBody = req.body.toString('utf8');

  const verification = verifyReplicateWebhook({
    webhookId: req.header('webhook-id'),
    webhookTimestamp: req.header('webhook-timestamp'),
    webhookSignature: req.header('webhook-signature'),
    rawBody,
  });

  if (!verification.valid) {
    console.warn('Webhook de Replicate rechazado:', verification.reason);
    return res.status(401).json({ error: 'firma inválida' });
  }

  const event = JSON.parse(rawBody);
  const predictionId = event.id;

  // Responder rápido — Replicate espera 2xx pronto o reintenta.
  res.status(200).json({ received: true });

  try {
    const { data: existing } = await supabase
      .from('generations')
      .select('id, project_id, user_id, status, credits_used')
      .eq('replicate_prediction_id', predictionId)
      .maybeSingle();

    if (!existing) {
      console.warn(`Webhook para prediction desconocida: ${predictionId}`);
      return;
    }

    // Idempotencia: si ya está en un estado final, un webhook duplicado no hace nada más.
    if (['succeeded', 'failed', 'canceled'].includes(existing.status)) return;

    const status = event.status; // starting | processing | succeeded | failed | canceled

    if (status === 'succeeded') {
      const temporaryOutputUrl = Array.isArray(event.output) ? event.output[0] : event.output;

      if (!temporaryOutputUrl) {
        await supabase
          .from('generations')
          .update({ status: 'failed', error_message: 'Replicate no devolvió output', completed_at: new Date().toISOString() })
          .eq('id', existing.id);
        await refundCredits(existing.user_id, existing.credits_used);
        return;
      }

      // Persistencia obligatoria: la URL de Replicate es temporal, nunca se guarda tal cual.
      const { url: permanentUrl } = await downloadAndStoreImage({
        sourceUrl: temporaryOutputUrl,
        projectId: existing.project_id,
        subfolder: 'generations',
      });

      await supabase
        .from('generations')
        .update({
          status: 'succeeded',
          output_image_url: permanentUrl,
          completed_at: new Date().toISOString(),
        })
        .eq('id', existing.id);
    } else if (status === 'failed' || status === 'canceled') {
      await supabase
        .from('generations')
        .update({ status, error_message: event.error || null, completed_at: new Date().toISOString() })
        .eq('id', existing.id);
      await refundCredits(existing.user_id, existing.credits_used);
    } else {
      await supabase.from('generations').update({ status }).eq('id', existing.id);
    }
  } catch (err) {
    console.error('Error procesando webhook de Replicate:', err);
    // Si la descarga a Storage falla, dejamos la generation en su estado actual
    // (no succeeded) para que sea visible como error en vez de mostrar la URL
    // temporal de Replicate como si fuera definitiva. También reintegramos
    // créditos: el usuario no debería pagar por una generación que no pudo verse.
    const { data: failedGen } = await supabase
      .from('generations')
      .select('user_id, credits_used')
      .eq('replicate_prediction_id', predictionId)
      .maybeSingle();

    await supabase
      .from('generations')
      .update({ status: 'failed', error_message: `Error persistiendo output: ${err.message}` })
      .eq('replicate_prediction_id', predictionId);

    if (failedGen) await refundCredits(failedGen.user_id, failedGen.credits_used);
  }
});

module.exports = router;
