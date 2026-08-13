const express = require('express');
const { supabase } = require('../lib/supabaseClient');
const { requireAuth } = require('../lib/auth');
const { getOrInitCredits } = require('../lib/credits');

const router = express.Router();

// GET /api/credits — saldo del usuario autenticado
router.get('/credits', requireAuth, async (req, res) => {
  try {
    const record = await getOrInitCredits(req.user.id);
    res.json({ credits: record.credits });
  } catch (err) {
    res.status(500).json({ error: 'no pudimos consultar tu saldo' });
  }
});

// GET /api/generations/:id — estado puntual (polling ligero desde el frontend,
// nunca se hace polling directo a Replicate desde el navegador)
router.get('/generations/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('generations').select('*').eq('id', req.params.id).single();
  if (error || !data) return res.status(404).json({ error: 'generación no encontrada' });
  if (data.user_id !== req.user.id) return res.status(404).json({ error: 'generación no encontrada' });
  res.json(data);
});

module.exports = router;
