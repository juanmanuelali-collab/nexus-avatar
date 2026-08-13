const express = require('express');
const { supabase } = require('../lib/supabaseClient');

const router = express.Router();

// TODO: reemplazar por auth real (ver nota en generations.js)
async function requireAuth(req, res, next) {
  if (!req.headers.authorization) return res.status(401).json({ error: 'no autenticado' });
  next();
}

const VALID_INPUT_MODES = ['photo', 'sketch', 'reference', 'photo_sketch', 'photo_reference', 'concept'];

// POST /api/projects — crear proyecto
// input_mode define qué le vamos a pedir subir al usuario en el paso siguiente
// (foto real, boceto, referencia, o combinaciones — ver sección 8.1 de la spec).
router.post('/', requireAuth, async (req, res) => {
  const { name, description, project_type, style, budget_level, user_id, input_mode = 'photo' } = req.body;

  if (!VALID_INPUT_MODES.includes(input_mode)) {
    return res.status(400).json({ error: `input_mode inválido: ${input_mode}` });
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({ name, description, project_type, style, budget_level, user_id, input_mode, status: 'draft' })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'no pudimos crear el proyecto' });
  res.status(201).json(data);
});

// GET /api/projects/:id — obtener proyecto
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'proyecto no encontrado' });
  res.json(data);
});

// GET /api/projects/:id/generations — historial
router.get('/:id/generations', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('generations')
    .select('*')
    .eq('project_id', req.params.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'no pudimos obtener el historial' });
  res.json(data);
});

// TODO: POST /:id/upload (foto real → set original_image_url + primary_input_url
// si es la primera imagen del proyecto)
// TODO: POST /:id/references (boceto/layout/estilo/elemento → set primary_input_url
// también si el proyecto todavía no tiene ninguna imagen cargada, para que
// projects.primary_input_url quede consistente sea cual sea el input_mode)
// Ambos deben subir a Supabase Storage bucket "landscape-storage" bajo
// projects/{project_id}/original/ y projects/{project_id}/references/ respectivamente.

module.exports = router;
