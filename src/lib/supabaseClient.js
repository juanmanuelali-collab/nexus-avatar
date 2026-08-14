const { createClient } = require('@supabase/supabase-js');

// service_role key — SOLO se usa en backend, nunca se expone al frontend.
// Al usar service_role, RLS no bloquea al backend, así que cada query acá
// debe filtrar explícitamente por user_id donde corresponda.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { db: { schema: 'landscape' } } // requiere exponer el schema "landscape" en Settings > API
);

module.exports = { supabase };
