require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const projectsRouter = require('./routes/projects');
const generationsRouter = require('./routes/generations');
const webhooksRouter = require('./routes/webhooks');

const app = express();

app.use(cors());

// El webhook necesita el body RAW para poder verificar la firma HMAC —
// se monta ANTES del express.json() global y sólo para ese path.
app.use('/api/webhooks', express.raw({ type: 'application/json' }), webhooksRouter);

app.use(express.json({ limit: '10mb' }));

app.use('/api/projects', projectsRouter);
app.use('/api', generationsRouter); // expone POST /api/projects/:id/generate

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`AI Landscape Designer corriendo en puerto ${PORT}`);
});
