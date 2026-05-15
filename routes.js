const { Router } = require('express');
const db = require('./db');
const { getStatus } = require('./tracker');

const router = Router();

router.get('/status', (req, res) => {
  res.json(getStatus());
});

router.get('/wipes', async (req, res) => {
  try { res.json(await db.listWipes()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/players', async (req, res) => {
  try {
    const wipeId = await resolveWipeId(req.query.wipe_id);
    if (!wipeId) return res.json([]);
    res.json(await db.getLeaderboard(wipeId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/players/:name', async (req, res) => {
  try {
    const wipeId = await resolveWipeId(req.query.wipe_id);
    if (!wipeId) return res.json({ player: req.params.name, sessions: [] });
    res.json({
      player: req.params.name,
      sessions: await db.getPlayerSessions(req.params.name, wipeId),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/sessions', async (req, res) => {
  try {
    const wipeId = await resolveWipeId(req.query.wipe_id);
    if (!wipeId) return res.json([]);
    res.json(await db.getRecentSessions(wipeId));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/history', async (req, res) => {
  try { res.json(await db.getRecentPolls()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

async function resolveWipeId(queryParam) {
  if (queryParam) return parseInt(queryParam, 10);
  return getStatus().currentWipe?.id ?? null;
}

module.exports = router;
