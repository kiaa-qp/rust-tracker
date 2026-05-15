const { Pool } = require('pg');

const db = new Pool({
  connectionString: process.env.TRACKER_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

db.on('error', err => console.error('[db] idle client error:', err.message));

// ── Queries ────────────────────────────────────────────────────────────────

async function getActiveWipe() {
  const { rows } = await db.query(
    'SELECT * FROM tracker_wipes WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
  );
  return rows[0] || null;
}

async function createWipe(mapName) {
  const { rows } = await db.query(
    'INSERT INTO tracker_wipes (started_at, map_name) VALUES ($1, $2) RETURNING *',
    [Date.now(), mapName]
  );
  return rows[0];
}

async function endWipe(id) {
  await db.query('UPDATE tracker_wipes SET ended_at = $1 WHERE id = $2', [Date.now(), id]);
}

async function getCurrentWipe(mapName) {
  let wipe = await getActiveWipe();
  if (!wipe) wipe = await createWipe(mapName);
  return wipe;
}

async function transitionWipe(oldId, newMapName) {
  await endWipe(oldId);
  return createWipe(newMapName);
}

async function startSession(wipeId, playerName, joinedAt) {
  const { rows } = await db.query(
    'INSERT INTO tracker_sessions (wipe_id, player_name, joined_at) VALUES ($1, $2, $3) RETURNING id',
    [wipeId, playerName, joinedAt]
  );
  return rows[0].id;
}

async function endSession(sessionId, leftAt) {
  const { rows } = await db.query('SELECT joined_at FROM tracker_sessions WHERE id = $1', [sessionId]);
  if (!rows[0]) return;
  const duration = Math.max(0, Math.floor((leftAt - rows[0].joined_at) / 1000));
  await db.query(
    'UPDATE tracker_sessions SET left_at = $1, duration_seconds = $2 WHERE id = $3',
    [leftAt, duration, sessionId]
  );
}

async function recordPoll(playerCount, maxPlayers, mapName) {
  await db.query(
    'INSERT INTO tracker_polls (polled_at, player_count, max_players, map_name) VALUES ($1, $2, $3, $4)',
    [Date.now(), playerCount, maxPlayers, mapName]
  );
}

async function getLeaderboard(wipeId) {
  const now = Date.now();
  const { rows } = await db.query(`
    SELECT
      player_name,
      COUNT(*)                                                               AS session_count,
      SUM(COALESCE(duration_seconds,
            GREATEST(0, FLOOR(($1 - joined_at) / 1000))))                  AS total_seconds,
      MIN(joined_at)                                                         AS first_seen,
      MAX(COALESCE(left_at, $1))                                             AS last_seen
    FROM tracker_sessions
    WHERE wipe_id = $2
    GROUP BY player_name
    ORDER BY total_seconds DESC
    LIMIT 10000
  `, [now, wipeId]);
  return rows;
}

async function getPlayerSessions(playerName, wipeId) {
  const { rows } = await db.query(
    'SELECT * FROM tracker_sessions WHERE player_name = $1 AND wipe_id = $2 ORDER BY joined_at DESC',
    [playerName, wipeId]
  );
  return rows;
}

async function getRecentSessions(wipeId) {
  const { rows } = await db.query(
    'SELECT * FROM tracker_sessions WHERE wipe_id = $1 ORDER BY joined_at DESC LIMIT 50',
    [wipeId]
  );
  return rows;
}

async function listWipes() {
  const { rows } = await db.query('SELECT * FROM tracker_wipes ORDER BY started_at DESC');
  return rows;
}

async function getRecentPolls() {
  const { rows } = await db.query('SELECT * FROM tracker_polls ORDER BY polled_at DESC LIMIT 120');
  return rows;
}

module.exports = {
  db,
  getCurrentWipe,
  transitionWipe,
  startSession,
  endSession,
  recordPoll,
  getLeaderboard,
  getPlayerSessions,
  getRecentSessions,
  listWipes,
  getRecentPolls,
};
