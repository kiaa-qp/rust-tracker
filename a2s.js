const dgram = require('dgram');

// A2S_INFO request (Source Engine Query)
const A2S_INFO = Buffer.from([
  0xFF, 0xFF, 0xFF, 0xFF, 0x54,
  0x53, 0x6F, 0x75, 0x72, 0x63, 0x65, 0x20,
  0x45, 0x6E, 0x67, 0x69, 0x6E, 0x65, 0x20,
  0x51, 0x75, 0x65, 0x72, 0x79, 0x00,
]);

// A2S_PLAYER challenge request
const A2S_PLAYER_CHALLENGE = Buffer.from([
  0xFF, 0xFF, 0xFF, 0xFF, 0x55, 0xFF, 0xFF, 0xFF, 0xFF,
]);

function send(socket, buf, host, port) {
  return new Promise((resolve, reject) =>
    socket.send(buf, 0, buf.length, port, host, err => err ? reject(err) : resolve())
  );
}

function readString(buf, offset) {
  const start = offset;
  while (offset < buf.length && buf[offset] !== 0) offset++;
  return { value: buf.toString('utf8', start, offset), offset: offset + 1 };
}

function parseInfo(buf) {
  let o = 6; // header(4) + type(1) + protocol(1)
  const name = readString(buf, o); o = name.offset;
  const map  = readString(buf, o); o = map.offset;
  readString(buf, o); o = readString(buf, o).offset; // folder
  readString(buf, o); o = readString(buf, o).offset; // game
  o += 2; // appid
  const playerCount = buf[o++];
  const maxPlayers  = buf[o++];
  return { name: name.value, map: map.value, playerCount, maxPlayers };
}

function parsePlayers(buf) {
  let o = 5; // header(4) + type(1)
  const count   = buf[o++];
  const players = [];
  for (let i = 0; i < count && o < buf.length; i++) {
    o++; // index byte
    const n = readString(buf, o); o = n.offset;
    const score = buf.readInt32LE(o);  o += 4;
    const time  = buf.readFloatLE(o);  o += 4;
    players.push({ name: n.value, score, time: Math.max(0, time) });
  }
  return players;
}

function query(host, port, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let info = null, players = null, done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      sock.close();
      // Return partial data if we at least got info
      if (info) resolve({ ...info, players: players || [] });
      else reject(new Error('A2S query timed out'));
    }, timeout);

    function tryFinish() {
      if (info && players && !done) {
        done = true;
        clearTimeout(timer);
        sock.close();
        resolve({ ...info, players });
      }
    }

    sock.on('message', async buf => {
      try {
        const type = buf[4];

        if (type === 0x41) {
          // Challenge response — resend with challenge bytes
          const challenge = buf.slice(5, 9);
          const infoWithChallenge = Buffer.concat([A2S_INFO, challenge]);
          const playerWithChallenge = Buffer.concat([
            Buffer.from([0xFF, 0xFF, 0xFF, 0xFF, 0x55]),
            challenge,
          ]);
          await send(sock, infoWithChallenge, host, port);
          await send(sock, playerWithChallenge, host, port);
        } else if (type === 0x49) {
          info = parseInfo(buf);
          tryFinish();
        } else if (type === 0x44) {
          players = parsePlayers(buf);
          tryFinish();
        }
      } catch (e) {
        // ignore parse errors on individual packets
      }
    });

    sock.on('error', err => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(err);
    });

    sock.bind(() => {
      send(sock, A2S_INFO, host, port).catch(reject);
      send(sock, A2S_PLAYER_CHALLENGE, host, port).catch(reject);
    });
  });
}

module.exports = { query };
