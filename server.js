// Hive Mind private local preview server. No third-party packages are required.
// Rooms are persisted on this machine and synchronized to open tabs with SSE.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
const DATA_DIR = process.env.HIVE_MIND_DATA_DIR || path.join(os.tmpdir(), 'hive-mind-private-preview');
const DATA_FILE = path.join(DATA_DIR, 'rooms.json');
const ROUND_MS = 30_000;
const HOST_GRACE_MS = 12_000;
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXYZ';
const MAX_ROOMS = 2000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_STREAMS_PER_PLAYER = 3;
const MAX_STREAMS_PER_ROOM = 40;
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);
// Per-IP budgets. A whole classroom can share one IP, so action and read budgets are generous.
const LIMITS = { create: [10, 60_000], join: [60, 60_000], action: [900, 60_000], read: [900, 60_000] };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const PROMPTS = [
  'A pizza topping', 'Something you take to the beach', 'A breakfast food', 'A sound that wakes you up',
  'A place to go on a first date', 'Something found in a backpack', 'A popular ice cream flavor', 'An animal you would not want as a roommate',
  'A food you eat with your hands', 'A reason to be late', 'Something you might collect', 'A thing that is always in the fridge',
  'A movie snack', 'Something you would pack for a road trip', 'A word you say when surprised', 'A green vegetable',
  'A household chore', 'Something you wear in winter', 'A place where people whisper', 'A food that is better homemade',
  'A thing you would find in a garden', 'A popular board game', 'Something that smells amazing', 'An excuse to leave a party',
  'A job that involves helping people', 'A thing you would bring to a picnic', 'A city you would love to visit', 'Something you do before bed',
  'A topping for a burger', 'An animal that moves slowly', 'A color you see in a sunset', 'Something that belongs in a toolbox',
  'A drink served cold', 'A thing people lose often', 'A food you would never eat for breakfast', 'A sound you hear in the city',
  'Something you might see at a wedding', 'A reason to open a window', 'A sport played with a ball', 'A thing you do on a rainy day',
  'A flavor of chips', 'Something you take on a plane', 'A thing that makes a room cozy', 'A fictional character with a pet',
  'A snack for a long movie', 'A place you would go to relax', 'An item found in a bathroom', 'A thing you might plant in spring',
  'A food people argue about', 'Something that belongs on a birthday cake', 'A song you know by heart', 'An object that is always on your desk',
  'A smell that reminds you of home', 'A reason someone might call a friend', 'A thing that makes mornings easier', 'Something you would see in a museum'
];

let rooms = new Map();
let streams = new Map();
fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
try { fs.chmodSync(DATA_DIR, 0o700); if (fs.existsSync(DATA_FILE)) fs.chmodSync(DATA_FILE, 0o600); } catch (_) { /* best effort */ }
try {
  const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  Object.entries(saved).forEach(([code, room]) => {
    if (!room || !Array.isArray(room.players) || !/^[A-Z]{4}$/.test(code)) return;
    if (Date.now() - (room.updatedAt || 0) > ROOM_TTL_MS) return;
    room.players.forEach(player => { if (!player.pid) player.pid = newPublicId(); });
    rooms.set(code, room);
  });
} catch (_) { /* First run: no saved rooms yet. */ }

function writeRoomsNow() {
  saveTimer = null;
  try {
    const serialized = Object.fromEntries(rooms.entries());
    const temp = DATA_FILE + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(serialized), { mode: 0o600 });
    fs.renameSync(temp, DATA_FILE);
  } catch (error) {
    console.error('Could not save rooms:', error.message);
  }
}

// Batch disk writes so busy rooms do not rewrite the file on every request.
let saveTimer = null;
function saveRooms() {
  if (!saveTimer) saveTimer = setTimeout(writeRoomsNow, 400);
}

function newPublicId() {
  return crypto.randomBytes(9).toString('base64url');
}

class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const buckets = new Map();
function rateLimited(req, kind) {
  const [max, windowMs] = LIMITS[kind];
  const key = kind + ':' + (req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.start > windowMs) { bucket = { start: now, count: 0 }; buckets.set(key, bucket); }
  bucket.count += 1;
  return bucket.count > max;
}

function json(res, status, value) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      reject(new ClientError(415, 'Please send JSON.'));
      return;
    }
    let body = '';
    let done = false;
    req.on('data', chunk => {
      if (done) return;
      body += chunk;
      if (body.length > 4_000) {
        done = true;
        reject(new ClientError(413, 'Request is too large.'));
      }
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      let value;
      try { value = body ? JSON.parse(body) : {}; }
      catch (_) { reject(new ClientError(400, 'Please send valid JSON.')); return; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { reject(new ClientError(400, 'Please send a JSON object.')); return; }
      resolve(value);
    });
    req.on('error', error => { if (!done) { done = true; reject(error); } });
  });
}

function stripInvisible(value) {
  return String(value == null ? '' : value).normalize('NFKC').replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/gu, '');
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return stripInvisible(value).trim().replace(/\s+/g, ' ').slice(0, 18).trim();
}

function validPlayerId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value) && !RESERVED_IDS.has(value);
}

function normalizeAnswer(value) {
  let result = String(value || '').normalize('NFKC').toLocaleLowerCase().trim();
  result = result.replace(/^[\s"'“”‘’([{]*?(?:a|an|the)\b[\s"'“”‘’)}\]]*/i, '');
  result = result.replace(/[’']/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  result = result.split(' ').map(word => {
    // Reduce singular and plural forms to one shared stem: cookie/cookies, shoe/shoes, pepperoni/pepperonis.
    let w = word;
    if (w.length >= 4 && w.endsWith('s') && !/(ss|us)$/.test(w) && !/^(tennis|paris|chess|bus|gas|news)$/.test(w)) w = w.slice(0, -1);
    if (w.length > 3 && w.endsWith('e')) w = w.slice(0, -1);
    if (w.length > 2 && w.endsWith('i')) w = w.slice(0, -1) + 'y';
    return w;
  }).join(' ');
  return result;
}

function shuffle(list) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function randomCode() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const code = Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
    if (!rooms.has(code)) return code;
  }
  throw new ClientError(503, 'The server is busy right now. Try again in a minute.');
}

function playerFor(room, id) {
  if (typeof id !== 'string' || !id) return undefined;
  return room.players.find(player => player.id === id);
}

function answerFor(room, id) {
  return Object.prototype.hasOwnProperty.call(room.answers || {}, id) ? room.answers[id] : undefined;
}

function activeCount(room) {
  return Object.values(room.answers || {}).filter(answer => answer && answer.locked).length;
}

function revealGroups(room) {
  const groups = new Map();
  const noAnswer = [];
  for (const player of room.players) {
    const answer = answerFor(room, player.id);
    if (!answer || !answer.text || !answer.text.trim()) {
      noAnswer.push(player.name);
      continue;
    }
    const normalized = normalizeAnswer(answer.text);
    if (!normalized) {
      noAnswer.push(player.name);
      continue;
    }
    if (!groups.has(normalized)) groups.set(normalized, { normalized, display: answer.text.trim(), players: [] });
    groups.get(normalized).players.push(player.name);
  }
  const sorted = Array.from(groups.values()).sort((a, b) => b.players.length - a.players.length || a.normalized.localeCompare(b.normalized));
  const highest = sorted.length ? sorted[0].players.length : 0;
  return { groups: sorted.map(group => ({ ...group, hive: group.players.length === highest && highest > 1 })), noAnswer };
}

function finishRound(room) {
  if (room.phase !== 'playing') return;
  const { groups, noAnswer } = revealGroups(room);
  for (const player of room.players) player.roundPoints = 0;
  for (const group of groups) {
    const points = group.players.length > 1 ? group.players.length : 0;
    for (const name of group.players) {
      const player = room.players.find(item => item.name === name);
      if (player) {
        player.score += points;
        player.roundPoints = points;
      }
    }
  }
  room.lastReveal = { round: room.round, groups, noAnswer, revealedAt: Date.now() };
  room.deadlineAt = null;
  room.phase = room.round === 8 ? 'finished' : 'reveal';
  room.updatedAt = Date.now();
  saveRooms();
}

function advanceIfExpired(room) {
  if (room.phase === 'playing' && room.deadlineAt && Date.now() >= room.deadlineAt) finishRound(room);
}

function publicView(room, playerId) {
  advanceIfExpired(room);
  const now = Date.now();
  const self = playerFor(room, playerId);
  const host = playerFor(room, room.hostId);
  const hasReveal = room.phase === 'reveal' || room.phase === 'finished';
  const result = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    roundCount: 8,
    prompt: room.phase === 'lobby' ? null : room.prompts[room.round - 1],
    deadlineAt: room.deadlineAt,
    serverNow: now,
    hostId: host ? host.pid : null,
    hostConnected: Boolean(host && now - host.lastSeen <= HOST_GRACE_MS),
    isHost: Boolean(self && self.id === room.hostId),
    selfId: self ? self.pid : null,
    selfName: self ? self.name : null,
    players: room.players.map(player => ({
      id: player.pid,
      name: player.name,
      score: player.score,
      roundPoints: player.roundPoints,
      isHost: player.id === room.hostId,
      connected: now - player.lastSeen <= HOST_GRACE_MS,
      locked: Boolean(answerFor(room, player.id) && answerFor(room, player.id).locked)
    })),
    lockedCount: activeCount(room),
    playerCount: room.players.length,
    ownAnswer: room.phase === 'playing' && self && answerFor(room, self.id) ? answerFor(room, self.id).text : '',
    reveal: hasReveal ? room.lastReveal : null,
    winners: room.phase === 'finished' ? room.players.filter(player => player.score === Math.max(...room.players.map(p => p.score))).map(player => player.name) : []
  };
  return result;
}

function roomError(room, res) {
  if (!room) {
    json(res, 404, { error: 'We could not find that room. Check the four-letter code and try again.' });
    return true;
  }
  return false;
}

function sendToStreams(code) {
  const clients = streams.get(code);
  const room = rooms.get(code);
  if (!clients || !room) return;
  for (const client of clients) {
    if (client.res.writableEnded) continue;
    const data = publicView(room, client.playerId);
    client.res.write('data: ' + JSON.stringify(data) + '\n\n');
  }
}

function broadcastAll() {
  for (const code of rooms.keys()) sendToStreams(code);
}

function addStream(code, playerId, res) {
  if (!streams.has(code)) streams.set(code, new Set());
  const roomStreams = streams.get(code);
  const mine = Array.from(roomStreams).filter(item => item.playerId === playerId);
  while (mine.length >= MAX_STREAMS_PER_PLAYER) { const old = mine.shift(); roomStreams.delete(old); old.res.end(); }
  if (roomStreams.size >= MAX_STREAMS_PER_ROOM) { res.end(); return; }
  const client = { playerId, res };
  roomStreams.add(client);
  const room = rooms.get(code);
  const player = playerFor(room, playerId);
  if (player) {
    player.lastSeen = Date.now();
    room.updatedAt = Date.now();
    saveRooms();
  }
  res.write('retry: 1000\n\n');
  sendToStreams(code);
  res.on('close', () => {
    streams.get(code)?.delete(client);
    if (streams.get(code)?.size === 0) streams.delete(code);
  });
}

function newRoom(hostId, name) {
  const now = Date.now();
  const code = randomCode();
  const room = {
    code,
    hostId,
    players: [{ id: hostId, pid: newPublicId(), name, score: 0, roundPoints: 0, lastSeen: now }],
    phase: 'lobby',
    round: 0,
    prompts: [],
    deadlineAt: null,
    answers: {},
    lastReveal: null,
    createdAt: now,
    updatedAt: now
  };
  rooms.set(code, room);
  saveRooms();
  return room;
}

function startGame(room) {
  room.prompts = shuffle(PROMPTS).slice(0, 8);
  room.round = 1;
  room.phase = 'playing';
  room.deadlineAt = Date.now() + ROUND_MS;
  room.answers = {};
  room.lastReveal = null;
  for (const player of room.players) {
    player.score = 0;
    player.roundPoints = 0;
  }
  room.updatedAt = Date.now();
  saveRooms();
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const action = parts[1];
  const code = (parts[2] || '').toUpperCase();
  if (parts.length > 4 || action !== 'rooms') return json(res, 404, { error: 'Unknown game endpoint.' });
  if (code && !/^[A-Z]{4}$/.test(code)) return json(res, 404, { error: 'We could not find that room. Check the four-letter code and try again.' });
  const kind = req.method === 'GET' ? 'read' : !code ? 'create' : parts[3] === 'join' ? 'join' : 'action';
  if (rateLimited(req, kind)) return json(res, 429, { error: 'Slow down a little and try again in a minute.' });

  if (req.method === 'POST' && action === 'rooms' && !code) {
    const body = await readBody(req);
    const name = cleanName(body.name);
    if (!name) return json(res, 400, { error: 'Add a nickname to create your room.' });
    if (!validPlayerId(body.playerId)) return json(res, 400, { error: 'This browser session needs a fresh player ID. Refresh and try again.' });
    if (rooms.size >= MAX_ROOMS) return json(res, 503, { error: 'The server is busy right now. Try again in a minute.' });
    const room = newRoom(body.playerId, name);
    return json(res, 201, publicView(room, body.playerId));
  }

  if (!code) return json(res, 404, { error: 'Unknown game endpoint.' });
  const room = rooms.get(code);

  if (req.method === 'GET' && parts[3] === 'events') {
    if (roomError(room, res)) return;
    const playerId = url.searchParams.get('playerId') || '';
    if (!playerFor(room, playerId)) return json(res, 403, { error: 'Join this room before opening its live updates.' });
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    addStream(code, playerId, res);
    return;
  }

  if (req.method === 'GET' && parts.length === 3) {
    if (roomError(room, res)) return;
    const playerId = url.searchParams.get('playerId') || '';
    const player = playerFor(room, playerId);
    if (!player) return json(res, 403, { error: 'This player is not in the room.' });
    player.lastSeen = Date.now();
    return json(res, 200, publicView(room, playerId));
  }

  if (req.method !== 'POST') return json(res, 404, { error: 'Unknown game endpoint.' });
  if (roomError(room, res)) return;
  const body = await readBody(req);
  if (parts[3] === 'join') {
    if (!validPlayerId(body.playerId)) return json(res, 400, { error: 'This browser session needs a fresh player ID. Refresh and try again.' });
    const name = cleanName(body.name);
    if (!name) return json(res, 400, { error: 'Add a nickname to join the room.' });
    const existing = playerFor(room, body.playerId);
    if (existing) {
      existing.lastSeen = Date.now();
      return json(res, 200, publicView(room, body.playerId));
    }
    if (room.players.length >= 12) return json(res, 409, { error: 'This hive is full. Rooms can hold up to 12 players.' });
    const duplicate = room.players.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) return json(res, 409, { error: 'That nickname is already in this room. Try another one.' });
    room.players.push({ id: body.playerId, pid: newPublicId(), name, score: 0, roundPoints: 0, lastSeen: Date.now() });
    saveRooms();
    broadcastAll();
    return json(res, 200, publicView(room, body.playerId));
  }
  const player = playerFor(room, body.playerId);
  if (!player) return json(res, 403, { error: 'This player is not in the room.' });
  player.lastSeen = Date.now();
  room.updatedAt = Date.now();

  if (parts[3] === 'heartbeat') {
    return json(res, 200, { ok: true });
  }

  if (parts[3] === 'start') {
    if (player.id !== room.hostId) return json(res, 403, { error: 'Only the host can start a game.' });
    if (room.players.length < 2) return json(res, 409, { error: 'Invite at least one more player before you start.' });
    if (room.phase !== 'lobby' && room.phase !== 'finished') return json(res, 409, { error: 'This game is already in progress.' });
    startGame(room);
    broadcastAll();
    return json(res, 200, publicView(room, body.playerId));
  }

  if (parts[3] === 'answer') {
    advanceIfExpired(room);
    if (room.phase !== 'playing') return json(res, 409, { error: 'This round has ended. The answers are being revealed.' });
    const answer = typeof body.answer === 'string' ? stripInvisible(body.answer).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    if (!answer) return json(res, 400, { error: 'Add an answer before you lock it in.' });
    room.answers[player.id] = { text: answer, locked: true, updatedAt: Date.now() };
    room.updatedAt = Date.now();
    if (activeCount(room) >= room.players.length) finishRound(room);
    else saveRooms();
    broadcastAll();
    return json(res, 200, publicView(room, body.playerId));
  }

  if (parts[3] === 'next') {
    if (player.id !== room.hostId) return json(res, 403, { error: 'Only the host can move the game forward.' });
    if (room.phase !== 'reveal') return json(res, 409, { error: 'The next round is not ready yet.' });
    room.round += 1;
    room.phase = 'playing';
    room.deadlineAt = Date.now() + ROUND_MS;
    room.answers = {};
    room.updatedAt = Date.now();
    saveRooms();
    broadcastAll();
    return json(res, 200, publicView(room, body.playerId));
  }

  return json(res, 404, { error: 'Unknown game action.' });
}

const ALLOWED_HOSTS = new Set(['127.0.0.1:' + PORT, 'localhost:' + PORT, '[::1]:' + PORT]);
const server = http.createServer(async (req, res) => {
  if (HOST === '127.0.0.1' && !ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
    res.writeHead(421, SECURITY_HEADERS); res.end('Misdirected request'); return;
  }
  let url;
  try { url = new URL(req.url, 'http://' + HOST + ':' + PORT); }
  catch (_) { res.writeHead(400, SECURITY_HEADERS); res.end('Bad request'); return; }
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch (error) {
      if (!(error instanceof ClientError)) console.error(error);
      if (!res.headersSent) json(res, error instanceof ClientError ? error.status : 500, { error: error instanceof ClientError ? error.message : 'Something went wrong. Try again.' });
      else res.end();
    }
    return;
  }
  if (req.method !== 'GET') return json(res, 405, { error: 'This preview only serves pages with GET.' });
  const file = url.pathname === '/' ? path.join(__dirname, 'index.html') : path.join(__dirname, path.basename(url.pathname));
  if (path.extname(file) !== '.html' && path.extname(file) !== '.ico' && path.extname(file) !== '.svg') {
    res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return;
  }
  fs.readFile(file, (error, contents) => {
    if (error) { res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return; }
    const contentType = file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.svg') ? 'image/svg+xml' : 'image/x-icon';
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Cache-Control': 'no-store' });
    res.end(contents);
  });
});

setInterval(() => {
  for (const room of rooms.values()) advanceIfExpired(room);
  broadcastAll();
}, 1000).unref();

setInterval(() => {
  const now = Date.now();
  let removed = false;
  for (const [code, room] of rooms) {
    const lastActive = Math.max(room.updatedAt || 0, ...room.players.map(player => player.lastSeen || 0));
    if (now - lastActive > ROOM_TTL_MS && !streams.has(code)) { rooms.delete(code); removed = true; }
  }
  for (const [key, bucket] of buckets) if (now - bucket.start > 120_000) buckets.delete(key);
  if (removed) saveRooms();
}, 60_000).unref();

function flushAndExit() { if (saveTimer) { clearTimeout(saveTimer); writeRoomsNow(); } process.exit(0); }
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

server.listen(PORT, HOST, () => {
  console.log('Hive Mind private preview ready at http://' + HOST + ':' + PORT);
  console.log('Rooms are saved in ' + DATA_FILE);
});
