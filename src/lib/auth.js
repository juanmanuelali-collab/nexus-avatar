const { supabase } = require('./supabaseClient');

/**
 * Verifica el JWT de Supabase Auth que manda el frontend en el header
 * Authorization: Bearer <token>. Usa el cliente service_role, que puede
 * validar el token de cualquier usuario vía supabase.auth.getUser(token).
 *
 * Adjunta req.user = { id, email, ... } si es válido.
 *
 * IMPORTANTE: como el backend usa la service_role key, Supabase RLS NO
 * filtra automáticamente las queries. Cada ruta debe seguir filtrando
 * explícitamente por req.user.id donde corresponda (ver projects.js).
 */
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: 'no autenticado' });
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return res.status(401).json({ error: 'token inválido o expirado' });
  }

  req.user = data.user;
  next();
}

/**
 * Chequea que el proyecto pertenezca al usuario autenticado.
 * Usar DESPUÉS de requireAuth y de haber cargado el proyecto.
 */
function assertOwnsProject(project, req, res) {
  if (!project || project.user_id !== req.user.id) {
    res.status(404).json({ error: 'proyecto no encontrado' });
    return false;
  }
  return true;
}

module.exports = { requireAuth, assertOwnsProject };
