// AI Landscape Designer — frontend vanilla JS
// Habla contra el backend Express (Authorization: Bearer <jwt de Supabase>).
// El Prompt Engine, la llamada a Replicate y el manejo de créditos viven
// TODOS en el backend — este archivo nunca construye un prompt ni llama a Replicate.

const supa = window.supabase.createClient(window.ENV.SUPABASE_URL, window.ENV.SUPABASE_ANON_KEY);

const state = {
  session: null,
  projects: [],
  currentProject: null,
  uploads: { original: null, sketch: null, style: null }, // { file, previewUrl }
  pollTimer: null,
};

const STATUS_MESSAGES = [
  'Analizando espacio…',
  'Identificando arquitectura…',
  'Diseñando paisajismo…',
  'Aplicando materiales…',
  'Generando vegetación…',
  'Ajustando iluminación…',
  'Finalizando render…',
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
  btn.textContent = isLoading
    ? (authMode === 'signin' ? 'Entrando…' : 'Creando cuenta…')
    : authLabels[authMode];
}

$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  // Saca el foco del input antes de disparar el request: evita que el navegador
  // reposicione el scroll para "seguir" al campo activo cuando cambia la pantalla.
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
  // Sin esto, el navegador a veces conserva la posición de scroll de la
  // pantalla anterior (o la del input que tenía foco) y el workspace aparece
  // arrancando desde el medio/abajo — se siente como un salto brusco.
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
    li.addEventListener('click', () => openProject(p.id));
    list.appendChild(li);
  });
}

$('#new-project-btn').addEventListener('click', () => {
  state.currentProject = null;
  $('#empty-state').hidden = true;
  $('#project-detail').hidden = true;
  $('#new-project-form').hidden = false;
  $all('.project-list li').forEach((li) => li.classList.remove('is-active'));
});

$('#project-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input_mode = document.querySelector('input[name="input_mode"]:checked').value;
  try {
    const project = await api('/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: $('#p-name').value.trim(),
        project_type: $('#p-type').value,
        style: $('#p-style').value,
        budget_level: $('#p-budget').value,
        input_mode,
      }),
    });
    await loadProjects();
    openProject(project.id);
  } catch (err) {
    alert(err.message);
  }
});

async function openProject(id) {
  stopPolling();
  const project = await api(`/projects/${id}`);
  state.currentProject = project;
  state.uploads = { original: null, sketch: null, style: null };

  $all('.project-list li').forEach((li) => li.classList.toggle('is-active', li.dataset.id === id));
  $('#empty-state').hidden = true;
  $('#new-project-form').hidden = true;
  $('#project-detail').hidden = false;

  $('#detail-name').textContent = project.name;
  $('#detail-type').textContent = `${project.project_type} · ${project.style} · ${project.input_mode}`;

  // Mostrar sólo los bloques de upload relevantes según input_mode
  const mode = project.input_mode;
  $('#upload-photo-block').style.display = ['photo', 'photo_sketch', 'photo_reference'].includes(mode) ? '' : 'none';
  $('#upload-sketch-block').style.display = ['sketch', 'photo_sketch'].includes(mode) ? '' : 'none';
  $('#upload-reference-block').style.display = ['reference', 'photo_reference', 'concept'].includes(mode) ? '' : 'none';

  if (project.original_image_url) {
    setPreview('photo', project.original_image_url);
  } else {
    resetPreview('photo');
  }
  resetPreview('sketch');
  resetPreview('reference');

  resetResultView();
  await loadHistory(id);
  updateGenerateButtonState();
}

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

// ---------- Generar ----------
function resetResultView() {
  $('#result-empty').hidden = false;
  $('#result-loading').hidden = true;
  $('#result-view').hidden = true;
}

$('#generate-btn').addEventListener('click', () => generate());
$('#regenerate-btn').addEventListener('click', () => generate());

function collectColorPalette() {
  const rows = $all('.color-input-row');
  const palette = [];
  rows.forEach((row) => {
    const colorInput = row.querySelector('input[type="color"]');
    const labelInput = row.querySelector('input[type="text"]');
    if (labelInput.value.trim()) {
      palette.push({ hex: colorInput.value, label: labelInput.value.trim() });
    }
  });
  return palette;
}

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
  $('#result-loading').hidden = false;

  const payload = {
    elements,
    user_description: $('#p-description').value.trim() || undefined,
    avoid_text: $('#p-avoid').value.trim() || undefined,
    camera_distance: $('#p-camera').value || undefined,
    aspect_ratio: $('#p-aspect').value || undefined,
    lighting_mood: $('#p-lighting').value || undefined,
    color_palette: collectColorPalette(),
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
    pollGeneration(res.generation_id);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    resetResultView();
    updateGenerateButtonState();
  }
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

function pollGeneration(generationId) {
  let msgIndex = 0;
  $('#loading-status').textContent = STATUS_MESSAGES[0];
  const msgTimer = setInterval(() => {
    msgIndex = (msgIndex + 1) % STATUS_MESSAGES.length;
    $('#loading-status').textContent = STATUS_MESSAGES[msgIndex];
  }, 2500);

  stopPolling();
  state.pollTimer = setInterval(async () => {
    try {
      const gen = await api(`/generations/${generationId}`);
      if (['succeeded', 'failed', 'canceled'].includes(gen.status)) {
        clearInterval(msgTimer);
        stopPolling();
        showResult(gen);
        loadHistory(state.currentProject.id);
        updateGenerateButtonState();
      }
    } catch {
      // ignorar errores puntuales de polling, sigue reintentando
    }
  }, 3000);
}

function showResult(gen) {
  $('#result-loading').hidden = true;

  if (gen.status !== 'succeeded') {
    const errorEl = $('#generate-error');
    errorEl.textContent = gen.error_message || 'La generación no pudo completarse. Podés reintentar.';
    errorEl.hidden = false;
    $('#result-empty').hidden = false;
    return;
  }

  $('#result-view').hidden = false;
  $('#conceptual-badge').hidden = !gen.is_conceptual;

  const before = gen.input_image_url || gen.output_image_url;
  $('#result-before').src = before;
  $('#result-after').src = gen.output_image_url;
  $('#download-link').href = gen.output_image_url;

  const hasBefore = Boolean(gen.input_image_url);
  $('#compare-block').style.display = hasBefore ? '' : 'block';
  $('#compare-after-wrap').style.width = hasBefore ? '50%' : '100%';
  $('#compare-slider').style.display = hasBefore ? '' : 'none';
}

$('#compare-slider').addEventListener('input', (e) => {
  const pct = e.target.value;
  $('#compare-after-wrap').style.width = `${pct}%`;
  $('#result-after').style.setProperty('--compare-w', `${(100 / pct) * 100}%`);
});

// ---------- Historial ----------
async function loadHistory(projectId) {
  const gens = await api(`/projects/${projectId}/generations`);
  const list = $('#history-list');
  list.innerHTML = '';
  gens.forEach((g) => {
    const li = document.createElement('li');
    li.textContent = `${g.status}${g.is_conceptual ? ' · concepto' : ''}`;
    li.dataset.status = g.status;
    if (g.status === 'succeeded') {
      li.style.cursor = 'pointer';
      li.addEventListener('click', () => showResult(g));
    }
    list.appendChild(li);
  });
}

// ---------- Boot ----------
(async function boot() {
  const { data } = await supa.auth.getSession();
  if (data.session) {
    await enterWorkspace();
  }
})();
