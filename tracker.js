const { getCurrentWipe, transitionWipe, startSession, endSession, recordPoll } = require('./db');

let snapshot    = new Map(); // bmPlayerId -> { sessionId, name }
let currentWipe = null;
let lastPollAt  = null;

let lastStatus = {
  online: false, playerCount: 0, maxPlayers: 0, mapName: null, lastPollAt: null,
};

// Called by POST /api/push from the local poller
// body: { playerCount, maxPlayers, mapName, wipeStartedAt, players: [{ id, name }] }
async function ingestPoll(body) {
  const now = Date.now();
  const { playerCount, maxPlayers, mapName, wipeStartedAt, players = [] } = body;

  lastStatus = { online: true, playerCount, maxPlayers, mapName, lastPollAt: now };
  await recordPoll(playerCount, maxPlayers, mapName);

  // ── Wipe detection ───────────────────────────────────────────────────────
  if (!currentWipe) {
    currentWipe = await getCurrentWipe(mapName);
  } else if (wipeStartedAt && wipeStartedAt > currentWipe.started_at) {
    console.log(`[tracker] New wipe detected`);
    for (const [, s] of snapshot) await endSession(s.sessionId, now);
    snapshot = new Map();
    currentWipe = await transitionWipe(currentWipe.id, mapName);
  }

  const activeMap = new Map(players.map(p => [p.id, p.name]));

  // Players who left
  for (const [bmId, s] of snapshot) {
    if (!activeMap.has(bmId)) {
      await endSession(s.sessionId, now);
      console.log(`[tracker] - ${s.name} left`);
      snapshot.delete(bmId);
    }
  }

  // Players who joined
  for (const [bmId, name] of activeMap) {
    if (!snapshot.has(bmId)) {
      const sessionId = await startSession(currentWipe.id, name, now);
      snapshot.set(bmId, { sessionId, name });
      console.log(`[tracker] + ${name} joined`);
    }
  }

  lastPollAt = now;
  console.log(`[tracker] ${new Date(now).toISOString()} — ${playerCount}/${maxPlayers} on ${mapName}`);
}

function startTracking() {
  console.log('[tracker] Ready — waiting for push from local poller');
}

function getStatus() {
  return {
    ...lastStatus,
    currentWipe,
    activePlayers: [...snapshot.values()].map(s => s.name),
  };
}

module.exports = { startTracking, getStatus, ingestPoll };
