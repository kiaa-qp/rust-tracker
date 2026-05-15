const cron  = require('node-cron');
const https = require('https');
const {
  getCurrentWipe, transitionWipe,
  startSession, endSession, recordPoll,
} = require('./db');

const BM_TOKEN   = process.env.BM_TOKEN;
const SERVER_ID  = '29566604'; // Vital Rust - EU Monthly
const HOST       = 'eu-monthly.vitalrust.com';
const PORT       = 28015;

let snapshot    = new Map(); // bmPlayerId -> { sessionId, name, lastSeen }
let currentWipe = null;
let lastPollAt  = null;

let lastStatus = {
  online: false, playerCount: 0, maxPlayers: 0, mapName: null, lastPollAt: null,
};

// ── HTTP helper ────────────────────────────────────────────────────────────

function bmGet(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.battlemetrics.com',
      path,
      method: 'GET',
      headers: { Authorization: `Bearer ${BM_TOKEN}` },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.error(`[BM] HTTP ${res.statusCode} for ${path} — ${data.slice(0, 200)}`);
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message} — body: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

// ── BattleMetrics queries ──────────────────────────────────────────────────

async function getServerInfo() {
  const data = await bmGet(`/servers/${SERVER_ID}`);
  return {
    playerCount: data.data.attributes.players,
    maxPlayers:  data.data.attributes.maxPlayers,
    mapName:     data.data.attributes.details?.map || 'Procedural Map',
    status:      data.data.attributes.status, // 'online' | 'offline'
  };
}

// Returns all players currently online — paginates through all pages
async function getActivePlayers() {
  const players = new Map();
  let url = `/players?filter[servers]=${SERVER_ID}&filter[online]=true&page[size]=100`;

  while (url) {
    const data = await bmGet(url);
    for (const p of (data.data || [])) {
      players.set(p.id, { name: p.attributes.name });
    }
    // Follow next page if present
    const next = data.links?.next;
    if (next) {
      // BM returns full URL in links.next — strip the hostname
      url = next.replace('https://api.battlemetrics.com', '');
    } else {
      url = null;
    }
  }

  return players;
}

// ── Wipe detection via BM server details ──────────────────────────────────
// BM exposes the last wipe date in server details for Rust servers

async function getWipeStart() {
  try {
    const data = await bmGet(`/servers/${SERVER_ID}`);
    const wipeStr = data.data.attributes.details?.rust_last_wipe;
    if (wipeStr) return new Date(wipeStr).getTime();
  } catch {}
  return null;
}

// ── Core poll ─────────────────────────────────────────────────────────────

async function poll() {
  const now = Date.now();
  try {
    await processPoll(now);
  } catch (err) {
    console.error(`[tracker] Poll error: ${err.message}`);
    lastStatus = { ...lastStatus, online: false, lastPollAt: now };
  }
  lastPollAt = now;
}

async function processPoll(now) {
  // Get server info + active players in parallel
  const [info, activePlayers] = await Promise.all([
    getServerInfo(),
    getActivePlayers(),
  ]);

  lastStatus = {
    online:      info.status === 'online',
    playerCount: info.playerCount,
    maxPlayers:  info.maxPlayers,
    mapName:     info.mapName,
    lastPollAt:  now,
  };

  await recordPoll(info.playerCount, info.maxPlayers, info.mapName);

  // ── Wipe detection ─────────────────────────────────────────────────────
  if (!currentWipe) {
    currentWipe = await getCurrentWipe(info.mapName);
  } else {
    // Check if BM reports a newer wipe date than our current wipe started
    const wipeStart = await getWipeStart();
    if (wipeStart && wipeStart > currentWipe.started_at) {
      console.log(`[tracker] New wipe detected — started ${new Date(wipeStart).toISOString()}`);
      for (const [, s] of snapshot) await endSession(s.sessionId, now);
      snapshot = new Map();
      currentWipe = await transitionWipe(currentWipe.id, info.mapName);
    }
  }

  // ── Diff active players ────────────────────────────────────────────────

  // Players who left (in snapshot but not in activePlayers)
  for (const [bmId, s] of snapshot) {
    if (!activePlayers.has(bmId)) {
      await endSession(s.sessionId, now);
      console.log(`[tracker] - ${s.name} left`);
      snapshot.delete(bmId);
    }
  }

  // Players who joined (in activePlayers but not in snapshot)
  for (const [bmId, p] of activePlayers) {
    if (!snapshot.has(bmId)) {
      const sessionId = await startSession(currentWipe.id, p.name, now);
      snapshot.set(bmId, { sessionId, name: p.name });
      console.log(`[tracker] + ${p.name} joined`);
    }
  }

  console.log(
    `[tracker] ${new Date(now).toISOString()} — ${info.playerCount}/${info.maxPlayers} on ${info.mapName}`
  );
}

// ── Public API ─────────────────────────────────────────────────────────────

function startTracking() {
  if (!BM_TOKEN) {
    console.error('[tracker] BM_TOKEN not set — cannot start');
    return;
  }
  console.log(`[tracker] Starting — polling BattleMetrics for server ${SERVER_ID} every 2 minutes`);
  poll();
  cron.schedule('*/2 * * * *', poll);
}

function getStatus() {
  return {
    ...lastStatus,
    currentWipe,
    activePlayers: [...snapshot.values()].map(s => s.name),
  };
}

module.exports = { startTracking, getStatus };
