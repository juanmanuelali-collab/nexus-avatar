// AI Landscape Designer — frontend vanilla JS
// Habla contra el backend Express (Authorization: Bearer <jwt de Supabase>).
// El Prompt Engine, la llamada a Replicate y el manejo de créditos viven
// TODOS en el backend — este archivo nunca construye un prompt ni llama a Replicate.

// Si por cualquier motivo el script de Supabase (CDN externo) no cargo a tiempo o fallo,
// esto NO debe tumbar el resto de la app -- sin este try/catch, un solo fallo de red ac
// (window.supabase undefined) frenaba TODO el JavaScript de la pagina, incluida la logica
// de los selects de Subtipo/Sector, botones, dropzones, etc.
let supa;
try {
  supa = window.supabase.createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);
} catch (err) {
  console.error('No se pudo inicializar el cliente de Supabase (¿fallo el CDN?):', err);
  supa = null;
}

const state = {
  session: null,
  projects: [],
  currentProject: null,
  draftProject: null, // proyecto creado como borrador en el paso 1 del asistente de "Nuevo proyecto"
  uploads: { original: null, sketch: null, style: null }, // { file, previewUrl }
  pollTimers: {}, // generationId -> intervalId (uno por cada uno de los 3 conceptos)
  generationsById: {}, // cache de generations ya resueltas, para abrir el detalle sin refetch
  compareImages: { before: null, after: null }, // urls para las tabs Antes/Después
};

const STATUS_MESSAGES = [
  'Analizando espacio…', 'Identificando arquitectura…', 'Diseñando paisajismo…',
  'Aplicando materiales…', 'Generando vegetación…', 'Ajustando iluminación…', 'Finalizando render…',
];

// ---------- Helpers ----------
const $ = (sel) => document.querySelector(sel);
const $all = (sel) => document.querySelectorAll(sel);

async function authHeader() {
  const { data } = await supa.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path, opts = {}) {
  const headers = { ...(await authHeader()), ...(opts.headers || {}) };
  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

async function apiUpload(path, file, extraFields = {}) {
  const form = new FormData();
  form.append('file', file);
  Object.entries(extraFields).forEach(([k, v]) => form.append(k, v));
  const headers = await authHeader();
  const res = await fetch(`/api${path}`, { method: 'POST', headers, body: form });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Error ${res.status}`);
  }
  return res.json();
}

// ---------- Auth ----------
let authMode = 'signin';
const authLabels = { signin: 'Entrar', signup: 'Crear cuenta' };

$all('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    $all('.auth-tab').forEach((t) => t.classList.remove('is-active'));
    tab.classList.add('is-active');
    authMode = tab.dataset.tab;
    $('#auth-submit').textContent = authLabels[authMode];
  });
});

function setAuthLoading(isLoading) {
  const btn = $('#auth-submit');
  btn.disabled = isLoading;
  btn.classList.toggle('is-loading', isLoading);
  btn.textContent = isLoading ? (authMode === 'signin' ? 'Entrando…' : 'Creando cuenta…') : authLabels[authMode];
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  document.activeElement?.blur();

  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  const errorEl = $('#auth-error');
  errorEl.hidden = true;
  setAuthLoading(true);

  try {
    const { error } =
      authMode === 'signin'
        ? await supa.auth.signInWithPassword({ email, password })
        : await supa.auth.signUp({ email, password });

    if (error) throw error;

    const { data } = await supa.auth.getSession();
    if (!data.session) {
      errorEl.textContent = 'Revisá tu email para confirmar la cuenta antes de entrar.';
      errorEl.hidden = false;
      setAuthLoading(false);
      return;
    }
    await enterWorkspace();
  } catch (err) {
    errorEl.textContent = err.message || 'No pudimos iniciar sesión.';
    errorEl.hidden = false;
    setAuthLoading(false);
  }
});

$('#signout-btn').addEventListener('click', async () => {
  await supa.auth.signOut();
  location.reload();
});

// ---------- Workspace shell ----------
async function enterWorkspace() {
  $('#auth-screen').hidden = true;
  $('#workspace-screen').hidden = false;
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  await Promise.all([loadProjects(), loadCredits()]);
}

async function loadCredits() {
  try {
    const { credits } = await api('/credits');
    $('#credits-value').textContent = credits;
  } catch {
    $('#credits-value').textContent = '—';
  }
}

async function loadProjects() {
  state.projects = await api('/projects');
  const list = $('#project-list');
  list.innerHTML = '';
  state.projects.forEach((p) => {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.dataset.id = p.id;
    if (state.currentProject?.id === p.id) li.classList.add('is-active');
    li.addEventListener('click', () => {
      openProject(p.id);
      closeRailOnMobile();
    });
    list.appendChild(li);
  });
}

// ---------- Menú mobile ----------
$('#rail-toggle').addEventListener('click', () => {
  const isOpen = $('#rail-body').classList.toggle('is-open');
  $('#rail-toggle').setAttribute('aria-expanded', String(isOpen));
});

function closeRailOnMobile() {
  $('#rail-body').classList.remove('is-open');
  $('#rail-toggle').setAttribute('aria-expanded', 'false');
}

// ---------- Taxonomía de proyecto (sección 1-2-29: categoría → subtipo/sector condicionales) ----------
const CATEGORY_DATA = {
  residencial: {
    types: ['Casa unifamiliar', 'Casa de campo', 'Quinta', 'Country / barrio privado', 'Villa', 'Edificio residencial'],
    sectors: ['Frente', 'Acceso', 'Fondo', 'Lateral', 'Patio', 'Jardín', 'Galería', 'Quincho', 'Piscina', 'Solárium', 'Estacionamiento', 'Huerta'],
  },
  comercial: {
    types: ['Hotel', 'Restaurante', 'Bar', 'Comercio', 'Oficina / corporativo', 'Complejo turístico'],
    sectors: ['Fachada', 'Acceso', 'Planta baja', 'Balcones', 'Terraza', 'Rooftop', 'Patio interno', 'Espacio común'],
  },
  rural: {
    types: ['Campo', 'Estancia', 'Bodega', 'Finca', 'Parque rural'],
    sectors: ['Acceso', 'Casco', 'Parque', 'Galería', 'Monte', 'Camino', 'Área productiva', 'Sector recreativo'],
  },
  especifico: {
    types: ['Patio', 'Jardín', 'Frente', 'Terraza', 'Rooftop', 'Balcón', 'Piscina', 'Quincho'],
    sectors: ['General'],
  },
};

function populateTypeAndSector(category) {
  const data = CATEGORY_DATA[category] || CATEGORY_DATA.residencial;
  const typeSelect = $('#p-type');
  const sectorSelect = $('#p-sector');
  typeSelect.innerHTML = data.types.map((t) => `<option value="${t}">${t}</option>`).join('');
  sectorSelect.innerHTML = data.sectors.map((s) => `<option value="${s}">${s}</option>`).join('');
}

function resetDraftWizard() {
  state.draftProject = null;
  $('#draft-step-1').hidden = false;
  $('#draft-step-2').hidden = true;
  $('#project-form').hidden = true;
  $('#p-name').value = '';
  $('#draft-step-1-error').hidden = true;
  document.querySelector('input[name="input_mode"][value="photo"]').checked = true;
  ['photo', 'sketch', 'reference'].forEach((kind) => resetDraftPreview(kind));
}

$('#new-project-btn').addEventListener('click', () => {
  state.currentProject = null;
  $('#empty-state').hidden = true;
  $('#project-detail').hidden = true;
  $('#new-project-form').hidden = false;
  resetDraftWizard();
  $all('.project-list li').forEach((li) => li.classList.remove('is-active'));
  closeRailOnMobile();
});

// ---------- PASO 1: crear el proyecto como borrador (nombre + que material se va a usar) ----------
$('#draft-step-1-continue').addEventListener('click', async () => {
  const name = $('#p-name').value.trim();
  const input_mode = document.querySelector('input[name="input_mode"]:checked').value;
  const errorEl = $('#draft-step-1-error');
  errorEl.hidden = true;

  if (!name) {
    errorEl.textContent = 'Ponele un nombre al proyecto para continuar.';
    errorEl.hidden = false;
    return;
  }

  try {
    const project = await api('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, input_mode }),
    });
    state.draftProject = project;

    // Mostrar solo la(s) zona(s) de carga que corresponden al modo elegido —
    // mismo criterio que ya se usaba en la vista de detalle.
    const showPhoto = ['photo', 'photo_sketch', 'photo_reference'].includes(input_mode);
    const showSketch = ['sketch', 'photo_sketch'].includes(input_mode);
    const showReference = ['reference', 'photo_reference', 'concept'].includes(input_mode);
    const referenceIsOptional = input_mode === 'concept';

    $('#upload-photo-draft-block').hidden = !showPhoto;
    $('#upload-sketch-draft-block').hidden = !showSketch;
    $('#upload-reference-draft-block').hidden = !showReference;
    $('#reference-draft-optional-tag').hidden = !referenceIsOptional;
    $('#draft-step-2-skip').hidden = !referenceIsOptional;

    $('#draft-step-1').hidden = true;
    $('#draft-step-2').hidden = false;
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

// ---------- PASO 2: subir el material (contra el proyecto borrador ya creado) ----------
function setDraftPreview(kind, url) {
  $(`#preview-${kind}-draft`).src = url;
  $(`#preview-${kind}-draft`).hidden = false;
  $(`#dz-${kind}-draft .dz-empty`).style.display = 'none';
}
function resetDraftPreview(kind) {
  $(`#preview-${kind}-draft`).hidden = true;
  $(`#dz-${kind}-draft .dz-empty`).style.display = '';
}
function wireDraftDropzone(kind, inputId, dzId) {
  $(dzId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !state.draftProject) return;
    try {
      if (kind === 'photo') {
        const updated = await apiUpload(`/projects/${state.draftProject.id}/upload`, file);
        state.draftProject.original_image_url = updated.original_image_url;
        setDraftPreview('photo', updated.original_image_url);
      } else {
        const reference_type = kind === 'sketch' ? 'sketch' : 'style';
        const ref = await apiUpload(`/projects/${state.draftProject.id}/references`, file, { reference_type });
        setDraftPreview(kind, ref.image_url);
      }
    } catch (err) {
      alert(err.message);
    }
  });
}
wireDraftDropzone('photo', '#input-photo-draft', '#dz-photo-draft');
wireDraftDropzone('sketch', '#input-sketch-draft', '#dz-sketch-draft');
wireDraftDropzone('reference', '#input-reference-draft', '#dz-reference-draft');

function goToStep3() {
  $('#draft-step-2').hidden = true;
  $('#project-form').hidden = false;
}
$('#draft-step-2-continue').addEventListener('click', goToStep3);
$('#draft-step-2-skip').addEventListener('click', goToStep3); // solo visible cuando la referencia es opcional (modo concepto)

$('#p-category').addEventListener('change', (e) => populateTypeAndSector(e.target.value));
populateTypeAndSector($('#p-category').value); // estado inicial al cargar la página

// ---------- PASO 3: completar el resto de los metadatos sobre el proyecto YA creado ----------
$('#project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.draftProject) return; // no deberia pasar -- el paso 3 solo se ve tras crear el borrador

  try {
    await api(`/projects/${state.draftProject.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_category: $('#p-category').value,
        project_type: $('#p-type').value,
        sector: $('#p-sector').value,
        style: $('#p-style').value,
        budget_level: $('#p-budget').value,
      }),
    });
    await loadProjects();
    openProject(state.draftProject.id);
  } catch (err) {
    alert(err.message);
  }
});

async function openProject(id) {
  stopAllPolling();
  const project = await api(`/projects/${id}`);
  state.currentProject = project;
  state.uploads = { original: null, sketch: null, style: null };
  state.generationsById = {};

  $all('.project-list li').forEach((li) => li.classList.toggle('is-active', li.dataset.id === id));
  $('#empty-state').hidden = true;
  $('#new-project-form').hidden = true;
  $('#project-detail').hidden = false;

  $('#detail-name').textContent = project.name;
  const typeParts = [project.project_type, project.sector, project.style, project.input_mode].filter(Boolean);
  $('#detail-type').textContent = typeParts.join(' · ');

  const mode = project.input_mode;
  $('#upload-photo-block').style.display = ['photo', 'photo_sketch', 'photo_reference'].includes(mode) ? '' : 'none';
  $('#upload-sketch-block').style.display = ['sketch', 'photo_sketch'].includes(mode) ? '' : 'none';
  $('#upload-reference-block').style.display = ['reference', 'photo_reference', 'concept'].includes(mode) ? '' : 'none';

  if (project.original_image_url) setPreview('photo', project.original_image_url);
  else resetPreview('photo');
  resetPreview('sketch');
  resetPreview('reference');

  populateBriefFields(project);
  renderSiteAnalysis(project.site_analysis);
  if (project.original_image_url && !project.site_analysis) pollSiteAnalysis(id);

  resetResultView();
  await loadHistory(id);
  updateGenerateButtonState();
}

$('#delete-project-btn').addEventListener('click', async () => {
  const project = state.currentProject;
  if (!project) return;

  const confirmed = confirm(
    `¿Eliminar "${project.name}" para siempre? Se borra el proyecto y todo su historial de generaciones. Esta acción no se puede deshacer.`
  );
  if (!confirmed) return;

  const btn = $('#delete-project-btn');
  btn.disabled = true;
  btn.textContent = 'Eliminando…';

  try {
    await api(`/projects/${project.id}`, { method: 'DELETE' });
    state.currentProject = null;
    await loadProjects();
    $('#project-detail').hidden = true;
    $('#empty-state').hidden = false;
  } catch (err) {
    alert(err.message || 'No pudimos eliminar el proyecto.');
    btn.disabled = false;
    btn.textContent = 'Eliminar proyecto';
  }
});

function setPreview(kind, url) {
  const img = $(`#preview-${kind === 'style' ? 'reference' : kind}`);
  img.src = url;
  img.hidden = false;
  $(`#dz-${kind === 'style' ? 'reference' : kind} .dz-empty`).style.display = 'none';
}
function resetPreview(kind) {
  const img = $(`#preview-${kind}`);
  img.hidden = true;
  $(`#dz-${kind} .dz-empty`).style.display = '';
}

function updateGenerateButtonState() {
  const p = state.currentProject;
  if (!p) return;
  const hasSomething = Boolean(p.original_image_url) || Object.values(state.uploads).some(Boolean);
  $('#generate-btn').disabled = !hasSomething;
}

// ---------- Landscape Brief (sección 53) ----------
function populateBriefFields(project) {
  const tags = project.purpose_tags || [];
  $all('#purpose-tags input[type="checkbox"]').forEach((el) => {
    el.checked = tags.includes(el.value);
  });
  $all('#maintenance-level .segmented-btn').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.value === project.maintenance_level);
  });
  $('#p-keep').value = project.keep_elements || '';
  $('#p-location').value = project.location || '';

  const keepList = project.keep_elements_list || [];
  $all('#keep-elements-list input[type="checkbox"]').forEach((el) => {
    el.checked = keepList.includes(el.value);
  });

  const doNotModifyList = project.do_not_modify || [];
  $all('#do-not-modify-list input[type="checkbox"]').forEach((el) => {
    el.checked = doNotModifyList.includes(el.value);
  });
}

function collectPurposeTags() {
  return Array.from($all('#purpose-tags input:checked')).map((el) => el.value);
}
function collectCheckedValues(containerId) {
  return Array.from($all(`#${containerId} input:checked`)).map((el) => el.value);
}

let briefSaveTimer = null;
async function saveBrief() {
  const project = state.currentProject;
  if (!project) return;

  const activeMaintenance = $('#maintenance-level .segmented-btn.is-active');
  const payload = {
    purpose_tags: collectPurposeTags(),
    maintenance_level: activeMaintenance?.dataset.value || null,
    keep_elements: $('#p-keep').value.trim() || null,
    keep_elements_list: collectCheckedValues('keep-elements-list'),
    do_not_modify: collectCheckedValues('do-not-modify-list'),
    location: $('#p-location').value.trim() || null,
  };

  try {
    const updated = await api(`/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    state.currentProject = updated;
    const hint = $('#brief-saved-hint');
    hint.hidden = false;
    hint.style.opacity = '1';
    setTimeout(() => { hint.style.opacity = '0'; setTimeout(() => { hint.hidden = true; }, 300); }, 1200);
  } catch {
    // el brief es un "nice to have" — si falla el autoguardado no interrumpimos al usuario
  }
}
function scheduleBriefSave() {
  clearTimeout(briefSaveTimer);
  briefSaveTimer = setTimeout(saveBrief, 600);
}

$all('#keep-elements-list input, #do-not-modify-list input').forEach((el) => el.addEventListener('change', scheduleBriefSave));
$('#p-location').addEventListener('blur', scheduleBriefSave);

$all('#purpose-tags input').forEach((el) => el.addEventListener('change', scheduleBriefSave));
$('#p-keep').addEventListener('blur', scheduleBriefSave);
$all('#maintenance-level .segmented-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    $all('#maintenance-level .segmented-btn').forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');
    scheduleBriefSave();
  });
});

// ---------- Site Analysis (sección 52) ----------
const SITE_ANALYSIS_LABELS = {
  existing_pool: 'Piscina existente',
  existing_lawn: 'Césped existente',
  hardscape_detected: 'Superficies duras',
  vegetation_detected: 'Vegetación existente',
  architecture_detected: 'Arquitectura detectada',
};

function renderSiteAnalysis(analysis) {
  const card = $('#site-analysis-card');
  const badgesEl = $('#site-analysis-badges');
  const listsEl = $('#site-analysis-lists');
  if (!analysis) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  badgesEl.innerHTML = '';
  listsEl.innerHTML = '';

  Object.entries(SITE_ANALYSIS_LABELS).forEach(([key, label]) => {
    if (!analysis[key]) return;
    const span = document.createElement('span');
    span.className = 'site-badge';
    span.textContent = label;
    badgesEl.appendChild(span);
  });

  if (typeof analysis.confidence === 'number') {
    const span = document.createElement('span');
    const pct = Math.round(analysis.confidence * 100);
    span.className = `site-badge${pct < 60 ? ' is-low-confidence' : ''}`;
    span.textContent = `Confianza estimada: ${pct}%`;
    badgesEl.appendChild(span);
  }

  const renderList = (title, items) => {
    if (!items?.length) return;
    const block = document.createElement('div');
    block.className = 'site-analysis-list-block';
    block.innerHTML = `<p class="site-analysis-list-title">${title}</p><ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
    listsEl.appendChild(block);
  };
  renderList('Problemas detectados', analysis.problems_detected);
  renderList('Materiales existentes', analysis.materials_detected);
  renderList('Zonas con potencial de mejora', analysis.intervention_zones);
}

// El análisis corre en background en el servidor — reintenta un par de veces
// después de subir la foto, sin molestar si nunca aparece (es opcional).
function pollSiteAnalysis(projectId, attempt = 0) {
  if (attempt >= 4) return;
  setTimeout(async () => {
    if (!state.currentProject || state.currentProject.id !== projectId) return;
    try {
      const project = await api(`/projects/${projectId}`);
      if (project.site_analysis) {
        state.currentProject = project;
        renderSiteAnalysis(project.site_analysis);
      } else {
        pollSiteAnalysis(projectId, attempt + 1);
      }
    } catch {
      // silencioso — no es crítico
    }
  }, 3500);
}

// ---------- Uploads ----------
function wireDropzone(kind, inputId, dzId) {
  $(dzId).addEventListener('click', () => $(inputId).click());
  $(inputId).addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file || !state.currentProject) return;

    try {
      if (kind === 'photo') {
        const updated = await apiUpload(`/projects/${state.currentProject.id}/upload`, file);
        state.currentProject.original_image_url = updated.original_image_url;
        setPreview('photo', updated.original_image_url);
        pollSiteAnalysis(state.currentProject.id);
      } else {
        const reference_type = kind === 'sketch' ? 'sketch' : 'style';
        const ref = await apiUpload(`/projects/${state.currentProject.id}/references`, file, { reference_type });
        state.uploads[kind === 'sketch' ? 'sketch' : 'style'] = ref;
        setPreview(kind, ref.image_url);
      }
      updateGenerateButtonState();
    } catch (err) {
      alert(err.message);
    }
  });
}
wireDropzone('photo', '#input-photo', '#dz-photo');
wireDropzone('sketch', '#input-sketch', '#dz-sketch');
wireDropzone('style', '#input-reference', '#dz-reference');

// ---------- Generar (3 conceptos) ----------
function resetResultView() {
  $('#result-empty').hidden = false;
  $('#concepts-grid').hidden = true;
  $('#concepts-grid').innerHTML = '';
  $('#result-view').hidden = true;
  stopAllPolling();
}

function stopAllPolling() {
  Object.values(state.pollTimers).forEach((t) => clearInterval(t));
  state.pollTimers = {};
}

$('#generate-btn').addEventListener('click', () => generate());
$('#regenerate-btn').addEventListener('click', () => generate());
$('#back-to-concepts-btn').addEventListener('click', () => {
  $('#result-view').hidden = true;
  $('#concepts-grid').hidden = false;
});

function collectColorPalette() {
  const rows = $all('.color-input-row');
  const palette = [];
  rows.forEach((row) => {
    const colorInput = row.querySelector('input[type="color"]');
    const labelInput = row.querySelector('input[type="text"]');
    if (labelInput.value.trim()) palette.push({ hex: colorInput.value, label: labelInput.value.trim() });
  });
  return palette;
}

const INTERVENTION_HINTS = [
  [25, 'Conservar — cambios mínimos'],
  [50, 'Intervención moderada'],
  [75, 'Transformación importante'],
  [100, 'Transformación completa'],
];
$('#p-intervention').addEventListener('input', (e) => {
  const val = Number(e.target.value);
  const [, label] = INTERVENTION_HINTS.find(([max]) => val <= max) || INTERVENTION_HINTS[INTERVENTION_HINTS.length - 1];
  $('#intervention-hint').textContent = label;
});

async function generate() {
  const project = state.currentProject;
  if (!project) return;

  const elements = Array.from($all('#elements-grid input:checked')).map((el) => el.value);
  const errorEl = $('#generate-error');
  const warningEl = $('#generate-warning');
  errorEl.hidden = true;
  warningEl.hidden = true;
  $('#generate-btn').disabled = true;

  $('#result-empty').hidden = true;
  $('#result-view').hidden = true;
  stopAllPolling();

  const payload = {
    elements,
    user_description: $('#p-description').value.trim() || undefined,
    avoid_text: $('#p-avoid').value.trim() || undefined,
    camera_distance: $('#p-camera').value || undefined,
    depth_of_field: $('#p-depth-of-field').checked,
    aspect_ratio: $('#p-aspect').value || undefined,
    lighting_mood: $('#p-lighting').value || undefined,
    color_palette: collectColorPalette(),
    intervention_level: Number($('#p-intervention').value),
    vegetation_criteria: collectCheckedValues('vegetation-criteria'),
  };

  try {
    const res = await api(`/projects/${project.id}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    loadCredits();
    if (res.warning) {
      warningEl.textContent = res.warning;
      warningEl.hidden = false;
    }
    renderConceptsGrid(res.concepts);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    $('#result-empty').hidden = false;
    updateGenerateButtonState();
  }
}

// Arma las 3 tarjetas de concepto y arranca un polling independiente para cada una.
function renderConceptsGrid(concepts) {
  const grid = $('#concepts-grid');
  grid.innerHTML = '';
  grid.hidden = false;

  concepts.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'concept-card';
    card.dataset.generationId = c.generation_id || '';

    const media = document.createElement('div');
    media.className = 'concept-card-media';
    if (c.error) {
      media.innerHTML = '<span class="concept-card-status is-error">Error</span>';
    } else {
      const spinner = document.createElement('div');
      spinner.className = 'concept-card-spinner';
      media.appendChild(spinner);
    }

    const body = document.createElement('div');
    body.className = 'concept-card-body';
    const label = document.createElement('p');
    label.className = 'concept-card-label';
    label.textContent = c.concept;
    const status = document.createElement('p');
    status.className = 'concept-card-status';
    status.textContent = c.error ? 'No se pudo generar' : 'Generando…';
    body.appendChild(label);
    body.appendChild(status);

    card.appendChild(media);
    card.appendChild(body);
    grid.appendChild(card);

    if (c.generation_id && !c.error) pollConceptCard(c.generation_id, card);
  });

  updateGenerateButtonState();
}

function pollConceptCard(generationId, cardEl) {
  const statusEl = cardEl.querySelector('.concept-card-status');
  let msgIndex = 0;
  const msgTimer = setInterval(() => {
    msgIndex = (msgIndex + 1) % STATUS_MESSAGES.length;
    if (statusEl) statusEl.textContent = STATUS_MESSAGES[msgIndex];
  }, 2500);

  state.pollTimers[generationId] = setInterval(async () => {
    try {
      const gen = await api(`/generations/${generationId}`);
      if (['succeeded', 'failed', 'canceled'].includes(gen.status)) {
        clearInterval(msgTimer);
        clearInterval(state.pollTimers[generationId]);
        delete state.pollTimers[generationId];
        state.generationsById[generationId] = gen;
        updateConceptCard(cardEl, gen);
        loadHistory(state.currentProject.id);
      }
    } catch {
      // sigue reintentando
    }
  }, 3000);
}

function updateConceptCard(cardEl, gen) {
  const media = cardEl.querySelector('.concept-card-media');
  const statusEl = cardEl.querySelector('.concept-card-status');

  if (gen.status === 'succeeded') {
    media.innerHTML = `<img src="${gen.output_image_url}" alt="${gen.concept_label || 'Concepto'}" loading="lazy" />`;
    statusEl.textContent = 'Listo — tocá para ver';
    statusEl.classList.add('is-ready');
    cardEl.classList.add('is-ready');
    cardEl.addEventListener('click', () => showResult(gen));
  } else {
    media.innerHTML = '<span class="concept-card-status is-error">No se pudo generar</span>';
    statusEl.textContent = gen.error_message || 'Falló';
    statusEl.classList.add('is-error');
  }
}

function showResult(gen) {
  $('#concepts-grid').hidden = true;
  $('#result-view').hidden = false;
  $('#conceptual-badge').hidden = !gen.is_conceptual;
  state.currentResultGeneration = gen;
  $('#edit-instruction').value = '';
  $('#edit-status').hidden = true;

  const hasBefore = Boolean(gen.input_image_url);
  state.compareImages = { before: gen.input_image_url || gen.output_image_url, after: gen.output_image_url };
  $('#compare-tabs').style.display = hasBefore ? '' : 'none';
  setCompareTab('after');

  renderMaterialStrip(gen);
}

function setCompareTab(tab) {
  $('#result-image').src = state.compareImages[tab] || state.compareImages.after;
  $all('.compare-tab').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === tab));
}
$all('.compare-tab').forEach((btn) => btn.addEventListener('click', () => setCompareTab(btn.dataset.tab)));

function renderMaterialStrip(gen) {
  const wrap = $('#material-strip');
  const thumbs = $('#material-thumbs');
  const urls = gen.reference_image_urls || [];
  thumbs.innerHTML = '';
  if (!urls.length) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  urls.forEach((url, i) => {
    const img = document.createElement('img');
    img.src = url;
    img.className = 'material-thumb';
    img.alt = i === 0 && gen.input_image_url ? 'Foto original usada' : 'Referencia usada';
    thumbs.appendChild(img);
  });
}

// Descarga real: bajamos el archivo a un blob local en vez de linkear directo
// a la URL de Supabase — cross-origin, el atributo "download" no funciona ahí.
$('#download-btn').addEventListener('click', async () => {
  const btn = $('#download-btn');
  const url = state.compareImages.after;
  if (!url) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Descargando…';

  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('No pudimos descargar la imagen');
    const blob = await res.blob();
    const blobUrl = URL.createObjectURL(blob);

    const projectName = (state.currentProject?.name || 'render').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = `${projectName}-${Date.now()}.webp`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(blobUrl);
  } catch {
    alert('No pudimos descargar la imagen. Probá de nuevo en un momento.');
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

// Editar un diseño ya generado, sin perder la version anterior --
// crea una generation nueva (parent_generation_id apunta a la actual).
$('#edit-btn').addEventListener('click', async () => {
  const btn = $('#edit-btn');
  const statusEl = $('#edit-status');
  const instruction = $('#edit-instruction').value.trim();
  const sourceGen = state.currentResultGeneration;
  statusEl.hidden = true;

  if (!instruction) {
    statusEl.textContent = 'Decinos qué querés cambiar del diseño.';
    statusEl.hidden = false;
    return;
  }
  if (!sourceGen?.id) return;

  btn.disabled = true;
  const originalText = btn.textContent;
  btn.textContent = 'Editando…';

  try {
    const result = await api(`/generations/${sourceGen.id}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction }),
    });
    pollEditResult(result.generation_id, btn, originalText, statusEl);
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.hidden = false;
    btn.disabled = false;
    btn.textContent = originalText;
  }
});

function pollEditResult(generationId, btn, originalText, statusEl) {
  let msgIndex = 0;
  const msgTimer = setInterval(() => {
    msgIndex = (msgIndex + 1) % STATUS_MESSAGES.length;
    btn.textContent = STATUS_MESSAGES[msgIndex];
  }, 2500);

  state.pollTimers[generationId] = setInterval(async () => {
    try {
      const gen = await api(`/generations/${generationId}`);
      if (['succeeded', 'failed', 'canceled'].includes(gen.status)) {
        clearInterval(msgTimer);
        clearInterval(state.pollTimers[generationId]);
        delete state.pollTimers[generationId];
        btn.disabled = false;
        btn.textContent = originalText;

        if (gen.status === 'succeeded') {
          showResult(gen); // muestra la version editada -- la anterior sigue en el historial
          loadHistory(state.currentProject.id);
        } else {
          statusEl.textContent = gen.error_message || 'No pudimos aplicar la edición. Probá de nuevo.';
          statusEl.hidden = false;
        }
      }
    } catch {
      // sigue reintentando
    }
  }, 3000);
}

// ---------- Historial ----------
async function loadHistory(projectId) {
  const gens = await api(`/projects/${projectId}/generations`);
  const list = $('#history-list');
  list.innerHTML = '';
  gens.forEach((g) => {
    const li = document.createElement('li');
    const label = g.concept_label ? `${g.concept_label} · ${g.status}` : g.status;
    li.textContent = `${label}${g.is_conceptual ? ' · concepto' : ''}`;
    li.dataset.status = g.status;
    if (g.status === 'succeeded') {
      li.addEventListener('click', () => showResult(g));
    }
    list.appendChild(li);
  });
}

// ---------- Boot ----------
(async function boot() {
  const { data } = await supa.auth.getSession();
  if (data.session) await enterWorkspace();
})();
