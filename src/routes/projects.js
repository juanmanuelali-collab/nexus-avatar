const express = require('express');
const multer = require('multer');
const { supabase } = require('../lib/supabaseClient');
const { requireAuth, assertOwnsProject } = require('../lib/auth');
const { uploadProjectFile } = require('../lib/storage');
const { analyzeSite } = require('../lib/ai/siteAnalysis');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB por archivo
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      return cb(new Error('Formato no soportado. Usá JPG, PNG o WEBP.'));
    }
    cb(null, true);
  },
});

const VALID_INPUT_MODES = ['photo', 'sketch', 'reference', 'photo_sketch', 'photo_reference', 'concept'];
const VALID_REFERENCE_TYPES = [
  'style', 'sketch', 'layout', 'architecture', 'landscape', 'plant', 'pool',
  'pergola', 'deck', 'lighting', 'furniture', 'material', 'other',
];

// GET /api/projects — listar MIS proyectos (para el dashboard del frontend)
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'no pudimos obtener tus proyectos' });
  res.json(data);
});

// POST /api/projects — crear proyecto
router.post('/', requireAuth, async (req, res) => {
  const {
    name, description, project_type, style, budget_level, input_mode = 'photo',
    purpose_tags = [], maintenance_level, keep_elements,
  } = req.body;

  if (!VALID_INPUT_MODES.includes(input_mode)) {
    return res.status(400).json({ error: `input_mode inválido: ${input_mode}` });
  }
  if (maintenance_level && !['bajo', 'medio', 'alto'].includes(maintenance_level)) {
    return res.status(400).json({ error: `maintenance_level inválido: ${maintenance_level}` });
  }

  const { data, error } = await supabase
    .from('projects')
    .insert({
      name,
      description,
      project_type,
      style,
      budget_level,
      input_mode,
      purpose_tags,
      maintenance_level: maintenance_level || null,
      keep_elements: keep_elements || null,
      user_id: req.user.id, // siempre del token, nunca del body
      status: 'draft',
    })
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'no pudimos crear el proyecto' });
  res.status(201).json(data);
});

// PATCH /api/projects/:id — actualizar el Landscape Brief (o cualquier campo editable)
router.patch('/:id', requireAuth, async (req, res) => {
  const { purpose_tags, maintenance_level, keep_elements, name, style, budget_level } = req.body;

  if (maintenance_level && !['bajo', 'medio', 'alto'].includes(maintenance_level)) {
    return res.status(400).json({ error: `maintenance_level inválido: ${maintenance_level}` });
  }

  const { data: project } = await supabase.from('projects').select('id, user_id').eq('id', req.params.id).single();
  if (!assertOwnsProject(project, req, res)) return;

  const updates = {};
  if (purpose_tags !== undefined) updates.purpose_tags = purpose_tags;
  if (maintenance_level !== undefined) updates.maintenance_level = maintenance_level || null;
  if (keep_elements !== undefined) updates.keep_elements = keep_elements || null;
  if (name !== undefined) updates.name = name;
  if (style !== undefined) updates.style = style;
  if (budget_level !== undefined) updates.budget_level = budget_level;

  const { data, error } = await supabase
    .from('projects')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'no pudimos actualizar el proyecto' });
  res.json(data);
});

// GET /api/projects/:id — obtener proyecto
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'proyecto no encontrado' });
  if (!assertOwnsProject(data, req, res)) return;
  res.json(data);
});

// DELETE /api/projects/:id — borrar proyecto
// generations y project_references se borran solos (ON DELETE CASCADE en la
// base). Los ARCHIVOS ya subidos a Storage (fotos, referencias, renders) NO
// se borran acá — quedan huérfanos en el bucket. Es una limitación conocida,
// aceptable por ahora: limpiar Storage requeriría listar y borrar cada
// archivo por su path, más trabajo del que amerita para esta etapa de test.
router.delete('/:id', requireAuth, async (req, res) => {
  const { data: project } = await supabase.from('projects').select('id, user_id').eq('id', req.params.id).single();
  if (!assertOwnsProject(project, req, res)) return;

  const { error } = await supabase.from('projects').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'no pudimos eliminar el proyecto' });
  res.status(204).send();
});

// GET /api/projects/:id/generations — historial
router.get('/:id/generations', requireAuth, async (req, res) => {
  const { data: project } = await supabase.from('projects').select('id, user_id').eq('id', req.params.id).single();
  if (!assertOwnsProject(project, req, res)) return;

  const { data, error } = await supabase
    .from('generations')
    .select('*')
    .eq('project_id', req.params.id)
    .order('created_at', { ascending: true });

  if (error) return res.status(500).json({ error: 'no pudimos obtener el historial' });
  res.json(data);
});

// POST /api/projects/:id/upload — foto REAL del espacio (image-to-image, preserva arquitectura)
router.post('/:id/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no se recibió ningún archivo' });

  const { data: project } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
  if (!assertOwnsProject(project, req, res)) return;

  try {
    const { url } = await uploadProjectFile({
      projectId: req.params.id,
      subfolder: 'original',
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    const updates = { original_image_url: url };
    if (!project.primary_input_url) updates.primary_input_url = url; // primer archivo del proyecto

    const { data: updated, error } = await supabase
      .from('projects')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(updated);

    // Site Analysis (sección 52): corre en background, no bloquea la respuesta.
    // Si falla, el proyecto simplemente queda sin análisis — no es crítico.
    analyzeSite(url)
      .then((analysis) => {
        if (!analysis) return;
        return supabase.from('projects').update({ site_analysis: analysis }).eq('id', req.params.id);
      })
      .catch((err) => console.error('Error en analyzeSite (background):', err));
  } catch (err) {
    console.error('Error en /upload:', err);
    res.status(500).json({ error: 'no pudimos procesar la imagen' });
  }
});

// POST /api/projects/:id/references — boceto / layout / referencia de estilo / elemento
router.post('/:id/references', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no se recibió ningún archivo' });

  const { reference_type, description } = req.body;
  if (!VALID_REFERENCE_TYPES.includes(reference_type)) {
    return res.status(400).json({ error: `reference_type inválido: ${reference_type}` });
  }

  const { data: project } = await supabase.from('projects').select('*').eq('id', req.params.id).single();
  if (!assertOwnsProject(project, req, res)) return;

  try {
    const { url } = await uploadProjectFile({
      projectId: req.params.id,
      subfolder: 'references',
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
    });

    const { data: reference, error } = await supabase
      .from('project_references')
      .insert({ project_id: req.params.id, image_url: url, reference_type, description: description || null })
      .select()
      .single();

    if (error) throw error;

    // Si es el primer archivo que sube el usuario en todo el proyecto (ej. modo
    // sketch/reference puro), lo registramos como primary_input_url.
    if (!project.primary_input_url) {
      await supabase.from('projects').update({ primary_input_url: url }).eq('id', req.params.id);
    }

    res.status(201).json(reference);
  } catch (err) {
    console.error('Error en /references:', err);
    res.status(500).json({ error: 'no pudimos procesar la referencia' });
  }
});

module.exports = router;
