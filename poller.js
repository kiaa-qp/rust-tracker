require('dotenv').config();
const https = require('https');

const BM_TOKEN    = process.env.BM_TOKEN;
const RAILWAY_URL = process.env.RAILWAY_URL; // e.g. https://rust-tracker-xxxx.up.railway.app
const PUSH_SECRET = process.env.PUSH_SECRET || '';
const SERVER_ID   = '29566604';
const INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

function get(path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.battlemetrics.com',
      path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${BM_TOKEN}`,
        'Accept': 'application/json',
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Parse error: ${data.slice(0, 100)}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function post(railwayUrl, body) {
  const data = JSON.stringify(body);
  const url  = new URL('/api/push', railwayUrl);
  const lib  = url.protocol === 'https:' ? require('https') : require('http');

  return new Promise((resolve, reject) => {
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     '/api/push',
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-push-secret':  PUSH_SECRET,
      },
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        console.log(`[poller] Railway responded: ${res.statusCode} ${d}`);
        resolve(d);
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Railway push timed out')); });
    req.write(data);
    req.end();
  });
}

async function getAllPlayers() {
  const players = [];
  let path = `/players?filter[servers]=${SERVER_ID}&filter[online]=true&page[size]=100`;
  while (path) {
    const data = await get(path);
    for (const p of (data.data || [])) {
      players.push({ id: p.id, name: p.attributes.name });
    }
    const next = data.links?.next;
    path = next ? next.replace('https://api.battlemetrics.com', '') : null;
  }
  return players;
}

async function poll() {
  try {
    const [serverData, players] = await Promise.all([
      get(`/servers/${SERVER_ID}`),
      getAllPlayers(),
    ]);

    const attr    = serverData.data.attributes;
    const details = attr.details || {};

    const body = {
      playerCount:  attr.players,
      maxPlayers:   attr.maxPlayers,
      mapName:      details.map || 'Procedural Map',
      wipeStartedAt: details.rust_last_wipe ? new Date(details.rust_last_wipe).getTime() : null,
      players,
    };

    console.log(`[poller] ${new Date().toISOString()} — ${players.length}/${attr.maxPlayers} players, pushing to Railway...`);
    await post(RAILWAY_URL, body);
    console.log(`[poller] Push OK`);
  } catch (err) {
    console.error(`[poller] Error: ${err.message}`);
  }
}

if (!BM_TOKEN)    { console.error('BM_TOKEN not set'); process.exit(1); }
if (!RAILWAY_URL) { console.error('RAILWAY_URL not set'); process.exit(1); }

console.log(`[poller] Starting — pushing to ${RAILWAY_URL} every 2 minutes`);
poll();
setInterval(poll, INTERVAL_MS);
