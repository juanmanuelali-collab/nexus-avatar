'use strict';
require('dotenv').config();
const express     = require('express');
const fetch       = require('node-fetch');
const path        = require('path');
const crypto      = require('crypto');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const { createClient } = require('@supabase/supabase-js');

const app  = express();
const PORT = process.env.PORT || 3002;

// ── ENV ────────────────────────────────────────────────────────
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD;
const JWT_SECRET       = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const REPLICATE_TOKEN  = process.env.REPLICATE_API_KEY;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_KEY;
const AVATAR_MODEL     = 'prunaai/p-video-avatar';

// ── SUPABASE ───────────────────────────────────────────────────
let _supa = null;
function getSupabase() {
  if (!_supa) _supa = createClient(SUPABASE_URL, SUPABASE_KEY);
  return _supa;
}

// ── SEGURIDAD ──────────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] === 'http') {
    return res.redirect(301, 'https://' + req.headers.host + req.url);
  }
  next();
});
app.use(rateLimit({ windowMs: 10 * 60 * 1000, max: 200, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── AUTH JWT ───────────────────────────────────────────────────
function makeToken() {
  const header  = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: Date.now(), exp: Date.now() + 12 * 3600 * 1000 }));
  const sig     = b64url(crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + payload).digest());
  return header + '.' + payload + '.' + sig;
}
function verifyToken(token) {
  try {
    const [h, p, s] = token.split('.');
    const expected  = b64url(crypto.createHmac('sha256', JWT_SECRET).update(h + '.' + p).digest());
    if (!timingSafe(s, expected)) return false;
    const { exp } = JSON.parse(Buffer.from(p, 'base64url').toString());
    return Date.now() < exp;
  } catch { return false; }
}
function b64url(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return buf.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function timingSafe(a, b) {
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
  catch { return false; }
}
const auth = (req, res, next) => {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (!verifyToken(token)) return res.status(401).json({ error: 'No autorizado' });
  next();
};
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });

// ── LOGIN ──────────────────────────────────────────────────────
app.post('/api/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  try {
    const ok = timingSafe(
      crypto.createHash('sha256').update(password||'').digest(),
      crypto.createHash('sha256').update(ADMIN_PASSWORD||'').digest()
    );
    if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });
    res.json({ ok: true, token: makeToken() });
  } catch { res.status(500).json({ error: 'Error interno' }); }
});

// ── CLIENTES ───────────────────────────────────────────────────
app.get('/api/clients', auth, async (req, res) => {
  try {
    const { data } = await getSupabase().from('avatar_clients').select('*').order('name');
    res.json({ ok: true, clients: data || [] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    const { name, slug } = req.body;
    if (!name || !slug) return res.status(400).json({ error: 'Nombre y slug requeridos' });
    const { data, error } = await getSupabase().from('avatar_clients')
      .upsert({ slug, name, avatars: [] }, { onConflict: 'slug' })
      .select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, client: data });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:slug', auth, async (req, res) => {
  try {
    await getSupabase().from('avatar_clients').delete().eq('slug', req.params.slug);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── AVATARES ───────────────────────────────────────────────────
app.post('/api/clients/:slug/avatars', auth, async (req, res) => {
  try {
    const { base64, mimeType, avatarName } = req.body;
    if (!base64 || !mimeType) return res.status(400).json({ error: 'Faltan datos' });

    const buffer   = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const ext      = mimeType.split('/')[1]?.replace('jpeg','jpg') || 'jpg';
    const fileName = `${req.params.slug}-${Date.now()}.${ext}`;

    const { error: upErr } = await getSupabase().storage
      .from('avatares').upload(fileName, buffer, { contentType: mimeType, upsert: false });
    if (upErr) throw new Error(upErr.message);

    const { data: urlData } = getSupabase().storage.from('avatares').getPublicUrl(fileName);
    const url = urlData?.publicUrl;

    // Agregar al array de avatares del cliente
    const { data: client } = await getSupabase().from('avatar_clients')
      .select('avatars').eq('slug', req.params.slug).single();
    const avatars = client?.avatars || [];
    avatars.push({ name: avatarName || 'Avatar ' + (avatars.length + 1), url, fileName });

    await getSupabase().from('avatar_clients').update({ avatars }).eq('slug', req.params.slug);
    res.json({ ok: true, url, avatars });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:slug/avatars/:fileName', auth, async (req, res) => {
  try {
    const { slug, fileName } = req.params;
    await getSupabase().storage.from('avatares').remove([fileName]);
    const { data: client } = await getSupabase().from('avatar_clients')
      .select('avatars').eq('slug', slug).single();
    const avatars = (client?.avatars || []).filter(a => a.fileName !== fileName);
    await getSupabase().from('avatar_clients').update({ avatars }).eq('slug', slug);
    res.json({ ok: true, avatars });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── GENERACIÓN DE VIDEO ────────────────────────────────────────
app.post('/api/generate', auth, async (req, res) => {
  try {
    const { avatarUrl, voiceScript, audioBase64, audioMimeType, voice, language, voicePrompt, videoPrompt, resolution } = req.body;
    if (!avatarUrl) return res.status(400).json({ error: 'Avatar requerido' });
    if (!voiceScript && !audioBase64) return res.status(400).json({ error: 'Script o audio requerido' });

    const input = {
      image:       avatarUrl,
      resolution:  resolution || '720p',
    };

    if (audioBase64) {
      input.audio = `data:${audioMimeType || 'audio/mp3'};base64,${audioBase64.replace(/^data:[^;]+;base64,/, '')}`;
    } else {
      input.voice_script  = voiceScript;
      input.voice         = voice || 'Zephyr (Female)';
      input.language      = language || 'es';
      if (voicePrompt) input.voice_prompt = voicePrompt;
    }
    if (videoPrompt) input.video_prompt = videoPrompt;

    console.log('[avatar] Iniciando generación | voz:', input.voice, '| resolución:', input.resolution);

    // Crear predicción en Replicate
    const createRes = await fetch('https://api.replicate.com/v1/models/' + AVATAR_MODEL + '/predictions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + REPLICATE_TOKEN,
        'Content-Type':  'application/json',
        'Prefer':        'wait=60',
      },
      body: JSON.stringify({ input }),
    });

    const prediction = await createRes.json();
    if (!createRes.ok) throw new Error(prediction.detail || 'Error en Replicate');

    console.log('[avatar] Predicción creada:', prediction.id, '| status:', prediction.status);
    res.json({ ok: true, predictionId: prediction.id, status: prediction.status, output: prediction.output });
  } catch(e) {
    console.error('[avatar] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── POLLING DE PREDICCIÓN ──────────────────────────────────────
app.get('/api/prediction/:id', auth, async (req, res) => {
  try {
    const r = await fetch('https://api.replicate.com/v1/predictions/' + req.params.id, {
      headers: { 'Authorization': 'Bearer ' + REPLICATE_TOKEN },
    });
    const data = await r.json();
    res.json({ ok: true, status: data.status, output: data.output, error: data.error, logs: data.logs });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── VOCES DISPONIBLES ──────────────────────────────────────────
app.get('/api/voices', auth, (req, res) => {
  res.json({
    voices: [
      { id: 'Zephyr (Female)',        name: 'Zephyr',        gender: 'F' },
      { id: 'Kore (Female)',          name: 'Kore',          gender: 'F' },
      { id: 'Leda (Female)',          name: 'Leda',          gender: 'F' },
      { id: 'Aoede (Female)',         name: 'Aoede',         gender: 'F' },
      { id: 'Callirrhoe (Female)',    name: 'Callirrhoe',    gender: 'F' },
      { id: 'Autonoe (Female)',       name: 'Autonoe',       gender: 'F' },
      { id: 'Despina (Female)',       name: 'Despina',       gender: 'F' },
      { id: 'Erinome (Female)',       name: 'Erinome',       gender: 'F' },
      { id: 'Laomedeia (Female)',     name: 'Laomedeia',     gender: 'F' },
      { id: 'Achernar (Female)',      name: 'Achernar',      gender: 'F' },
      { id: 'Gacrux (Female)',        name: 'Gacrux',        gender: 'F' },
      { id: 'Pulcherrima (Female)',   name: 'Pulcherrima',   gender: 'F' },
      { id: 'Vindemiatrix (Female)',  name: 'Vindemiatrix',  gender: 'F' },
      { id: 'Sulafat (Female)',       name: 'Sulafat',       gender: 'F' },
      { id: 'Puck (Male)',            name: 'Puck',          gender: 'M' },
      { id: 'Charon (Male)',          name: 'Charon',        gender: 'M' },
      { id: 'Fenrir (Male)',          name: 'Fenrir',        gender: 'M' },
      { id: 'Orus (Male)',            name: 'Orus',          gender: 'M' },
      { id: 'Enceladus (Male)',       name: 'Enceladus',     gender: 'M' },
      { id: 'Iapetus (Male)',         name: 'Iapetus',       gender: 'M' },
      { id: 'Umbriel (Male)',         name: 'Umbriel',       gender: 'M' },
      { id: 'Algenib (Male)',         name: 'Algenib',       gender: 'M' },
      { id: 'Algieba (Male)',         name: 'Algieba',       gender: 'M' },
      { id: 'Schedar (Male)',         name: 'Schedar',       gender: 'M' },
      { id: 'Achird (Male)',          name: 'Achird',        gender: 'M' },
      { id: 'Zubenelgenubi (Male)',   name: 'Zubenelgenubi', gender: 'M' },
      { id: 'Sadachbia (Male)',       name: 'Sadachbia',     gender: 'M' },
      { id: 'Sadaltager (Male)',      name: 'Sadaltager',    gender: 'M' },
      { id: 'Alnilam (Male)',         name: 'Alnilam',       gender: 'M' },
      { id: 'Rasalgethi (Male)',      name: 'Rasalgethi',    gender: 'M' },
    ],
    languages: [
      { id: 'es', name: '🇦🇷 Español' },
      { id: 'en', name: '🇺🇸 English' },
      { id: 'fr', name: '🇫🇷 Français' },
      { id: 'de', name: '🇩🇪 Deutsch' },
      { id: 'it', name: '🇮🇹 Italiano' },
      { id: 'pt', name: '🇧🇷 Português' },
      { id: 'ja', name: '🇯🇵 日本語' },
      { id: 'ko', name: '🇰🇷 한국어' },
      { id: 'hi', name: '🇮🇳 हिन्दी' },
    ],
  });
});

// ── HEALTH ─────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, app: 'nexus-avatar' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`✦ Nexus Avatar`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Replicate: ${REPLICATE_TOKEN ? '✓' : '✗'}`);
  console.log(`  Supabase:  ${SUPABASE_URL ? '✓' : '✗'}`);
});
