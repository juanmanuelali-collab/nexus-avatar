const express = require('express');
const { verifyReplicateWebhook } = require('../lib/ai/replicate/verify');
const { supabase } = require('../lib/supabaseClient');

const router = express.Router();

// IMPORTANTE: esta ruta necesita el body RAW (Buffer), no JSON parseado,
// porque la firma HMAC se calcula sobre el string exacto recibido.
// Se monta con express.raw() en server.js SOLO para este path.
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
    // Idempotencia: buscamos si ya procesamos este prediction_id en estado final.
    const { data: existing } = await supabase
      .from('generations')
      .select('id, status')
      .eq('replicate_prediction_id', predictionId)
      .maybeSingle();

    if (!existing) {
      console.warn(`Webhook para prediction desconocida: ${predictionId}`);
      return;
    }

    if (['succeeded', 'failed', 'canceled'].includes(existing.status)) {
      // Ya procesado antes (webhook duplicado) — no hacer nada más.
      return;
    }

    const status = event.status; // starting | processing | succeeded | failed | canceled

    if (status === 'succeeded') {
      const outputUrl = Array.isArray(event.output) ? event.output[0] : event.output;
      // TODO: descargar outputUrl y subirlo a Supabase Storage (landscape-storage),
      // guardar la URL PERMANENTE acá, no la temporal de Replicate.
      await supabase
        .from('generations')
        .update({
          status: 'succeeded',
          output_image_url: outputUrl, // reemplazar por URL de Supabase Storage una vez implementada la descarga
          completed_at: new Date().toISOString(),
        })
        .eq('replicate_prediction_id', predictionId);
    } else if (status === 'failed' || status === 'canceled') {
      await supabase
        .from('generations')
        .update({
          status,
          error_message: event.error || null,
          completed_at: new Date().toISOString(),
        })
        .eq('replicate_prediction_id', predictionId);
    } else {
      await supabase
        .from('generations')
        .update({ status })
        .eq('replicate_prediction_id', predictionId);
    }
  } catch (err) {
    console.error('Error procesando webhook de Replicate:', err);
  }
});

module.exports = router;
