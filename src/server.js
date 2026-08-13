require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const projectsRouter = require('./routes/projects');
const generationsRouter = require('./routes/generations');
const webhooksRouter = require('./routes/webhooks');
const miscRouter = require('./routes/misc');

const app = express();

app.use(cors());

// El webhook necesita el body RAW para poder verificar la firma HMAC —
// se monta ANTES del express.json() global y sólo para ese path.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

app.use(express.json({ limit: '10mb' }));

app.use('/api/projects', projectsRouter);
app.use('/api', generationsRouter); // expone POST /api/projects/:id/generate
app.use('/api', miscRouter); // expone GET /api/credits, GET /api/generations/:id

// Config pública para el frontend (Vanilla JS SPA) — SOLO valores no secretos.
// El anon key de Supabase está diseñado para ser público (RLS lo protege del
// lado de la base), a diferencia del service_role key que nunca sale del backend.
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `window.ENV = ${JSON.stringify({
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    })};`
  );
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Landscape Designer corriendo en puerto ${PORT}`);
});
