const express = require('express');
const { supabase } = require('../lib/supabaseClient');
const { requireAuth, assertOwnsProject } = require('../lib/auth');
const { suggestPlants } = require('../lib/ai/plantSuggestions');

const router = express.Router();

const VALID_SUN = ['pleno_sol', 'parcial', 'sombra', 'no_se'];
const VALID_ORIENTATION = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO', 'no_se'];
const VALID_SOIL = ['arcilloso', 'arenoso', 'franco', 'no_se'];
const VALID_DRAINAGE = ['bien', 'regular', 'mal', 'no_se'];
const VALID_STATUS = ['proposed', 'accepted', 'modified', 'rejected'];

// POST /api/projects/:id/plant-suggestions
// Genera sugerencias de especies con IA (sin base propia) y las guarda como
// "proposed". Opcionalmente actualiza las condiciones del sitio del proyecto
// si vienen en el body (asi quedan guardadas para la proxima vez).
router.post('/projects/:id/plant-suggestions', requireAuth, async (req, res) => {
  const projectId = req.params.id;
  const { sun_exposure, orientation, soil_type, drainage } = req.body;

  if (sun_exposure && !VALID_SUN.includes(sun_exposure)) {
    return res.status(400).json({ error: `sun_exposure inválido: ${sun_exposure}` });
  }
  if (orientation && !VALID_ORIENTATION.includes(orientation)) {
    return res.status(400).json({ error: `orientation inválida: ${orientation}` });
  }
  if (soil_type && !VALID_SOIL.includes(soil_type)) {
    return res.status(400).json({ error: `soil_type inválido: ${soil_type}` });
  }
  if (drainage && !VALID_DRAINAGE.includes(drainage)) {
    return res.status(400).json({ error: `drainage inválido: ${drainage}` });
  }

  try {
    const { data: project, error: projectError } = await supabase
      .from('projects').select('*').eq('id', projectId).single();
    if (projectError || !project) return res.status(404).json({ error: 'proyecto no encontrado' });
    if (!assertOwnsProject(project, req, res)) return;

    // Si vienen condiciones nuevas en el body, se guardan en el proyecto para la proxima vez.
    const conditionUpdates = {};
    if (sun_exposure !== undefined) conditionUpdates.sun_exposure = sun_exposure || null;
    if (orientation !== undefined) conditionUpdates.orientation = orientation || null;
    if (soil_type !== undefined) conditionUpdates.soil_type = soil_type || null;
    if (drainage !== undefined) conditionUpdates.drainage = drainage || null;

    let effectiveProject = project;
    if (Object.keys(conditionUpdates).length) {
      const { data: updated, error: updateErr } = await supabase
        .from('projects').update(conditionUpdates).eq('id', projectId).select().single();
      if (!updateErr) effectiveProject = updated;
    }

    const conditions = {
      location: effectiveProject.location,
      sunExposure: effectiveProject.sun_exposure,
      orientation: effectiveProject.orientation,
      soilType: effectiveProject.soil_type,
      drainage: effectiveProject.drainage,
      style: effectiveProject.style,
      maintenanceLevel: effectiveProject.maintenance_level,
      purposeTags: effectiveProject.purpose_tags || [],
      budgetLevel: effectiveProject.budget_level,
    };

    const suggestions = await suggestPlants(conditions);
    if (!suggestions.length) {
      return res.status(502).json({ error: 'la IA no devolvió sugerencias, probá de nuevo' });
    }

    const rows = suggestions.map((s) => ({
      project_id: projectId,
      common_name: s.common_name,
      scientific_name: s.scientific_name || null,
      suggested_data: s,
      site_conditions_snapshot: conditions,
      status: 'proposed',
    }));

    const { data: inserted, error: insertError } = await supabase
      .from('plant_suggestions').insert(rows).select();
    if (insertError) throw insertError;

    res.status(201).json(inserted);
  } catch (err) {
    console.error('Error en /plant-suggestions:', err);
    res.status(500).json({ error: err.message || 'no pudimos generar sugerencias de especies' });
  }
});

// GET /api/projects/:id/plant-suggestions — listar las sugerencias de un proyecto
router.get('/projects/:id/plant-suggestions', requireAuth, async (req, res) => {
  const { data: project } = await supabase.from('projects').select('id, user_id').eq('id', req.params.id).single();
  if (!assertOwnsProject(project, req, res)) return;

  const { data, error } = await supabase
    .from('plant_suggestions').select('*').eq('project_id', req.params.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: 'no pudimos obtener las sugerencias' });
  res.json(data);
});

// PATCH /api/plant-suggestions/:id — el profesional marca la sugerencia como
// aceptada / modificada / rechazada. Esto es lo que, con el tiempo, arma la
// base de especies propia con uso real en vez de datos curados de entrada.
router.patch('/plant-suggestions/:id', requireAuth, async (req, res) => {
  const { status, professional_notes } = req.body;
  if (!status || !VALID_STATUS.includes(status)) {
    return res.status(400).json({ error: `status inválido: ${status}` });
  }

  const { data: suggestion } = await supabase
    .from('plant_suggestions').select('*, projects!inner(user_id)').eq('id', req.params.id).single();
  if (!suggestion || suggestion.projects.user_id !== req.user.id) {
    return res.status(404).json({ error: 'sugerencia no encontrada' });
  }

  const { data, error } = await supabase
    .from('plant_suggestions')
    .update({ status, professional_notes: professional_notes || null, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'no pudimos actualizar la sugerencia' });
  res.json(data);
});

module.exports = router;
