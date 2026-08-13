const { supabase } = require('./supabaseClient');

// Créditos gratis que recibe un usuario nuevo la primera vez que se le
// consulta el saldo (no existe fila en user_credits todavía).
// TODO: esto es un placeholder para la etapa de test del vertical. Reemplazar
// por un flujo real de compra/plan de créditos antes de abrir a clientes reales.
const FREE_CREDITS_ON_FIRST_USE = 10;

/** Devuelve el saldo actual, creando la fila con créditos gratis si es la primera vez. */
async function getOrInitCredits(userId) {
  const { data: existing } = await supabase.from('user_credits').select('*').eq('user_id', userId).maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('user_credits')
    .insert({ user_id: userId, credits: FREE_CREDITS_ON_FIRST_USE })
    .select()
    .single();

  if (error) throw new Error(`No se pudo inicializar créditos: ${error.message}`);
  return created;
}

/**
 * Verifica que el usuario tenga saldo suficiente. NO descuenta — sólo chequea.
 * @returns {Promise<{ ok: boolean, credits: number }>}
 */
async function checkUserCredits(userId, required) {
  const record = await getOrInitCredits(userId);
  return { ok: record.credits >= required, credits: record.credits };
}

/**
 * Descuenta créditos. Se llama recién DESPUÉS de crear la prediction en Replicate
 * exitosamente (si Replicate falla al crearla, no se descuenta nada).
 * Usa un update condicional (credits >= amount) para evitar saldo negativo en
 * caso de requests concurrentes.
 */
async function deductCredits(userId, amount) {
  const { data, error } = await supabase.rpc('landscape_deduct_credits', {
    p_user_id: userId,
    p_amount: amount,
  });

  if (error) throw new Error(`No se pudo descontar créditos: ${error.message}`);
  if (!data) throw new Error('Saldo insuficiente al momento de descontar (condición de carrera)');
}

/** Reintegra créditos cuando una generación termina en failed/canceled. */
async function refundCredits(userId, amount) {
  if (!amount) return;
  const record = await getOrInitCredits(userId);
  await supabase
    .from('user_credits')
    .update({ credits: record.credits + amount, updated_at: new Date().toISOString() })
    .eq('user_id', userId);
}

module.exports = { checkUserCredits, deductCredits, refundCredits, getOrInitCredits };
