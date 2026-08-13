/**
 * Verificación criptográfica de webhooks de Replicate.
 * Replicate envía: webhook-id, webhook-timestamp, webhook-signature (HMAC-SHA256).
 * NUNCA procesar un evento de webhook sin pasar por acá antes.
 *
 * Requiere que la ruta del webhook use body raw (Buffer), no JSON parseado,
 * porque la firma se calcula sobre el string exacto del body.
 */
const crypto = require('crypto');

const MAX_TIMESTAMP_DRIFT_SECONDS = 5 * 60; // 5 minutos, anti replay-attack

function verifyReplicateWebhook({ webhookId, webhookTimestamp, webhookSignature, rawBody }) {
  const secret = process.env.REPLICATE_WEBHOOK_SECRET;
  if (!secret) throw new Error('REPLICATE_WEBHOOK_SECRET no configurado');

  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    return { valid: false, reason: 'faltan headers de firma' };
  }

  // Anti replay: rechazar timestamps muy viejos o muy en el futuro
  const now = Math.floor(Date.now() / 1000);
  const ts = parseInt(webhookTimestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > MAX_TIMESTAMP_DRIFT_SECONDS) {
    return { valid: false, reason: 'timestamp fuera de rango (posible replay)' };
  }

  // El secret viene con prefijo whsec_, la parte útil es lo que sigue al primer '_'
  const secretBytes = Buffer.from(secret.split('_')[1] || secret, 'base64');

  const signedContent = `${webhookId}.${webhookTimestamp}.${rawBody}`;
  const expectedSignature = crypto
    .createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  // webhook-signature puede traer varias firmas separadas por espacio, formato "v1,<sig>"
  const receivedSignatures = webhookSignature
    .split(' ')
    .map((s) => s.split(',')[1])
    .filter(Boolean);

  const isValid = receivedSignatures.some((sig) =>
    crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSignature))
  );

  return isValid ? { valid: true } : { valid: false, reason: 'firma no coincide' };
}

module.exports = { verifyReplicateWebhook };
