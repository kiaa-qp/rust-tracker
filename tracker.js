const cron = require('node-cron');
const a2s  = require('./a2s');
const {
  getCurrentWipe, transitionWipe,
  startSession, endSession, recordPoll,
} = require('./db');

const HOST = 'eu-monthly.vitalrust.com';
const PORT = 28015;

// Each entry: { sessionId, label, time }  (time = seconds connected at last poll)
let snapshot = [];
let currentWipe = null;
let lastPollAt  = null;
let anonSeq     = 0;

let lastStatus = {
  online: false, playerCount: 0, maxPlayers: 0, mapName: null, lastPollAt: null,
};

async function queryServer() {
  const result = await a2s.query(HOST, PORT);
  return {
    map:        result.map,
    maxplayers: result.maxPlayers,
    players:    result.players,
  };
}

// ── Anonymous player matching ─────────────────────────────────────────────
// When censorplayerlist is on, all names are blank. Each player's `time`
// field (seconds connected) grows by ~elapsedSecs per poll, so we match
// players across polls by finding the closest expected value.

function matchAnonymous(prev, next, elapsedSecs) {
  const tolerance  = Math.max(90, elapsedSecs * 0.5);
  const usedPrev   = new Set();
  const usedNext   = new Set();
  const pairs      = [];
  const candidates = [];

  for (let pi = 0; pi < prev.length; pi++) {
    for (let ni = 0; ni < next.length; ni++) {
      const diff = Math.abs(next[ni].time - (prev[pi].time + elapsedSecs));
      if (diff <= tolerance) candidates.push({ pi, ni, diff });
    }
  }
  candidates.sort((a, b) => a.diff - b.diff);

  for (const { pi, ni } of candidates) {
    if (!usedPrev.has(pi) && !usedNext.has(ni)) {
      pairs.push({ pi, ni });
      usedPrev.add(pi);
      usedNext.add(ni);
    }
  }

  return {
    continuing: pairs,
    left:   prev.map((_, i) => i).filter(i => !usedPrev.has(i)),
    joined: next.map((_, i) => i).filter(i => !usedNext.has(i)),
  };
}

// ── Core poll ─────────────────────────────────────────────────────────────

async function poll() {
  const now = Date.now();
  let result;

  try {
    result = await queryServer();
  } catch (err) {
    console.error(`[tracker] Query failed: ${err.message}`);
    lastStatus = { ...lastStatus, online: false, lastPollAt: now };
    return;
  }

  try {
    await processPoll(now, result);
  } catch (err) {
    console.error(`[tracker] Poll processing error: ${err.message}`);
  }
}

async function processPoll(now, result) {

  const mapName    = result.map       || 'Procedural Map';
  const players    = result.players   || [];
  const maxPlayers = result.maxplayers || 200;

  lastStatus = { online: true, playerCount: players.length, maxPlayers, mapName, lastPollAt: now };

  await recordPoll(players.length, maxPlayers, mapName);

  // ── Wipe detection ───────────────────────────────────────────────────────
  if (!currentWipe) {
    currentWipe = await getCurrentWipe(mapName);
  } else if (currentWipe.map_name && currentWipe.map_name !== mapName) {
    console.log(`[tracker] Wipe — map changed "${currentWipe.map_name}" → "${mapName}"`);
    await Promise.all(snapshot.map(s => endSession(s.sessionId, now)));
    snapshot = [];
    currentWipe = await transitionWipe(currentWipe.id, mapName);
  }

  const elapsedSecs = lastPollAt ? (now - lastPollAt) / 1000 : 0;
  const hasNames    = players.some(p => p.name && p.name.trim().length > 0);
  const newSnapshot = [];

  if (hasNames) {
    // ── Named players ──────────────────────────────────────────────────────
    const prevByName = new Map(snapshot.map(s => [s.label, s]));
    const seen = new Set();

    for (const p of players) {
      const name = p.name.trim() || `unknown_${p.time.toFixed(0)}`;
      seen.add(name);
      if (prevByName.has(name)) {
        newSnapshot.push({ ...prevByName.get(name), time: p.time });
      } else {
        const sessionId = await startSession(currentWipe.id, name, now);
        newSnapshot.push({ sessionId, label: name, time: p.time });
        console.log(`[tracker] + ${name} joined`);
      }
    }

    for (const [name, s] of prevByName) {
      if (!seen.has(name)) {
        await endSession(s.sessionId, now);
        console.log(`[tracker] - ${name} left`);
      }
    }

  } else {
    // ── Anonymous players ──────────────────────────────────────────────────
    const { continuing, left, joined } = matchAnonymous(snapshot, players, elapsedSecs);

    for (const { pi, ni } of continuing) {
      const p = players[ni];
      if (!p) continue;
      newSnapshot.push({ ...snapshot[pi], time: p.time });
    }

    for (const pi of left) {
      await endSession(snapshot[pi].sessionId, now);
      console.log(`[tracker] - ${snapshot[pi].label} left`);
    }

    for (const ni of joined) {
      const p = players[ni];
      if (!p) continue;
      const label     = `Raider #${++anonSeq}`;
      const sessionId = await startSession(currentWipe.id, label, now);
      newSnapshot.push({ sessionId, label, time: p.time });
      console.log(`[tracker] + ${label} joined (${Math.floor(p.time)}s connected)`);
    }
  }

  snapshot    = newSnapshot.filter(Boolean);
  lastPollAt  = now;

  console.log(`[tracker] ${new Date(now).toISOString()} — ${players.length}/${maxPlayers} on ${mapName}`);
}

// ── Public API ─────────────────────────────────────────────────────────────

function startTracking() {
  console.log(`[tracker] Starting — querying ${HOST}:${PORT} every 2 minutes`);
  poll();
  cron.schedule('*/2 * * * *', poll);
}

function getStatus() {
  return {
    ...lastStatus,
    currentWipe,
    activePlayers: snapshot.map(s => s.label),
  };
}

module.exports = { startTracking, getStatus };
