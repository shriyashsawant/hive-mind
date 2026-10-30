// Hive Mind API: create and join rooms, read room state, and play.
'use strict';
const game = require('./game');
const { store, usingRedis } = require('./store');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store'
};
const LIMITS = { create: [10, 60], join: [60, 60], action: [900, 60], read: [1800, 60] };
const localHits = new Map();

function send(res, status, value) {
  res.statusCode = status;
  for (const [name, header] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, header);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(value));
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '') || (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function limited(req, kind) {
  const [max, windowSeconds] = LIMITS[kind];
  const key = kind + ':' + clientIp(req);
  // Creating and joining are counted in shared storage; frequent reads are counted per server instance.
  if (kind === 'create' || kind === 'join') return (await store.hit(key, windowSeconds)) > max;
  const now = Date.now();
  const entry = localHits.get(key);
  if (!entry || now - entry.start > windowSeconds * 1000) { localHits.set(key, { start: now, count: 1 }); return false; }
  entry.count += 1;
  if (localHits.size > 5000) localHits.clear();
  return entry.count > max;
}

function readBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new game.ClientError(415, 'Please send JSON.');
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { throw new game.ClientError(400, 'Please send valid JSON.'); } }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new game.ClientError(400, 'Please send a JSON object.');
  if (JSON.stringify(body).length > 4000) throw new game.ClientError(413, 'Request is too large.');
  return body;
}

const notFound = () => new game.ClientError(404, 'We could not find that room. Check the four-letter code and try again.');

// Load, change and save a room, retrying if another player saved at the same moment.
async function update(code, playerId, change) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const doc = await store.load(code);
    if (!doc) throw notFound();
    const changed = change(doc.room);
    if (!changed || await store.save(code, doc.version, doc.room)) {
      const player = game.playerFor(doc.room, playerId);
      if (player) { await store.touch(code, player.pid); doc.seen[player.pid] = String(Date.now()); }
      return doc;
    }
    await new Promise(resolve => setTimeout(resolve, 15 + Math.random() * 60));
  }
  throw new game.ClientError(503, 'The room is busy. Try again.');
}

async function handle(req, res, rawCode, action) {
  // On Vercel, rooms must live in shared storage; separate function instances cannot share memory.
  if (process.env.VERCEL && !usingRedis) return send(res, 503, { error: 'The game storage is not connected yet. Add Upstash Redis to this Vercel project.' });
  const code = String(rawCode || '').toUpperCase();
  const method = req.method;
  if (code && !/^[A-Z]{4}$/.test(code)) return send(res, 404, { error: notFound().message });
  const kind = method === 'GET' ? 'read' : !code ? 'create' : action === 'join' ? 'join' : 'action';
  if (await limited(req, kind)) return send(res, 429, { error: 'Slow down a little and try again in a minute.' });

  // Create a room
  if (!code) {
    if (method !== 'POST') return send(res, 405, { error: 'Use POST to create a room.' });
    const body = readBody(req);
    const name = game.cleanName(body.name);
    if (!name) return send(res, 400, { error: 'Add a nickname to create your room.' });
    if (!game.validPlayerId(body.playerId)) return send(res, 400, { error: 'This browser session needs a fresh player ID. Refresh and try again.' });
    for (let attempt = 0; attempt < 25; attempt++) {
      const newCode = game.randomCode();
      const room = game.newRoom(newCode, body.playerId, name);
      if (await store.create(newCode, room)) {
        await store.touch(newCode, room.players[0].pid);
        return send(res, 201, game.publicView(room, body.playerId, { [room.players[0].pid]: String(Date.now()) }));
      }
    }
    return send(res, 503, { error: 'The server is busy right now. Try again in a minute.' });
  }

  // Read the room (also marks the player as here)
  if (method === 'GET' && !action) {
    const playerId = String(req.headers['x-player-id'] || '');
    let doc = await store.load(code);
    if (!doc) throw notFound();
    const player = game.playerFor(doc.room, playerId);
    if (!player && game.wasRemoved(doc.room, playerId)) return send(res, 403, { error: 'The host removed you from this room.', reason: 'removed' });
    if (!player && doc.room.phase === 'closed') return send(res, 410, { error: 'This room has ended.', reason: 'closed' });
    if (!player) return send(res, 403, { error: 'This player is not in the room.' });
    if (doc.room.phase === 'playing' && doc.room.deadlineAt && Date.now() >= doc.room.deadlineAt) {
      doc = await update(code, playerId, room => game.advanceIfExpired(room));
    } else {
      await store.touch(code, player.pid);
      doc.seen[player.pid] = String(Date.now());
    }
    return send(res, 200, game.publicView(doc.room, playerId, doc.seen));
  }

  if (method !== 'POST') return send(res, 405, { error: 'Unknown game action.' });
  const body = readBody(req);
  const playerId = body.playerId;
  if (!game.validPlayerId(playerId)) return send(res, 400, { error: 'This browser session needs a fresh player ID. Refresh and try again.' });

  if (action === 'join') {
    const name = game.cleanName(body.name);
    if (!name) return send(res, 400, { error: 'Add a nickname to join the room.' });
    const doc = await update(code, playerId, room => {
      if (room.phase === 'closed') throw new game.ClientError(410, 'This room has ended. Ask the host for a new code.');
      if (game.wasRemoved(room, playerId)) throw new game.ClientError(403, 'The host removed you from this room.');
      if (game.playerFor(room, playerId)) return false;
      game.addPlayer(room, playerId, name);
      room.updatedAt = Date.now();
      return true;
    });
    return send(res, 200, game.publicView(doc.room, playerId, doc.seen));
  }

  const requirePlayer = room => { const player = game.playerFor(room, playerId); if (!player) throw new game.ClientError(403, 'This player is not in the room.'); return player; };
  const requireHost = room => { if (requirePlayer(room).id !== room.hostId) throw new game.ClientError(403, 'Only the host can do that.'); };
  const requireOpen = room => { if (room.phase === 'closed') throw new game.ClientError(410, 'This room has ended.'); };
  let change;
  if (action === 'heartbeat') change = room => { requirePlayer(room); return false; };
  else if (action === 'leave') change = room => game.removePlayer(room, requirePlayer(room).id);
  else if (action === 'kick') {
    const target = typeof body.target === 'string' ? body.target : '';
    change = room => {
      requireHost(room);
      requireOpen(room);
      const player = room.players.find(item => item.pid === target);
      if (!player) throw new game.ClientError(404, 'That player already left.');
      if (player.id === room.hostId) throw new game.ClientError(409, 'You cannot remove yourself. Use End room instead.');
      room.removed = [...(room.removed || []), player.id].slice(-50);
      return game.removePlayer(room, player.id);
    };
  } else if (action === 'close') change = room => { requireHost(room); requireOpen(room); game.closeRoom(room); return true; };
  else if (action === 'settings') change = room => {
    requireHost(room);
    requireOpen(room);
    if (room.phase !== 'lobby' && room.phase !== 'finished') throw new game.ClientError(409, 'Change settings between games.');
    game.applySettings(room, body);
    return true;
  };
  else if (action === 'skip') change = room => {
    requireHost(room);
    if (room.phase !== 'playing') throw new game.ClientError(409, 'You can only skip during a round.');
    game.skipPrompt(room);
    return true;
  };
  else if (action === 'host') {
    const target = typeof body.target === 'string' ? body.target : '';
    change = room => {
      requireHost(room);
      requireOpen(room);
      const player = room.players.find(item => item.pid === target);
      if (!player) throw new game.ClientError(404, 'That player already left.');
      room.hostId = player.id;
      room.updatedAt = Date.now();
      return true;
    };
  } else if (action === 'react') {
    const emoji = typeof body.emoji === 'string' ? body.emoji : '';
    change = room => { requireOpen(room); game.addReaction(room, requirePlayer(room), emoji); return true; };
  }
  else if (action === 'start') change = room => {
    requireHost(room);
    requireOpen(room);
    if (room.players.length < 2) throw new game.ClientError(409, 'Invite at least one more player before you start.');
    if (room.phase !== 'lobby' && room.phase !== 'finished') throw new game.ClientError(409, 'This game is already in progress.');
    game.startGame(room);
    return true;
  };
  else if (action === 'next') change = room => {
    requireHost(room);
    requireOpen(room);
    if (room.phase !== 'reveal') throw new game.ClientError(409, 'The next round is not ready yet.');
    game.nextRound(room);
    return true;
  };
  else if (action === 'answer') {
    const answer = game.cleanAnswer(body.answer);
    if (!answer) return send(res, 400, { error: 'Add an answer before you lock it in.' });
    change = room => {
      const player = requirePlayer(room);
      game.advanceIfExpired(room);
      if (room.phase !== 'playing') throw new game.ClientError(409, 'This round has ended. The answers are being revealed.');
      room.answers[player.id] = { text: answer, locked: true, updatedAt: Date.now() };
      room.updatedAt = Date.now();
      if (game.lockedCount(room) >= room.players.length) game.finishRound(room);
      return true;
    };
  } else return send(res, 404, { error: 'Unknown game action.' });

  const doc = await update(code, playerId, change);
  if (action === 'heartbeat' || action === 'leave') return send(res, 200, { ok: true });
  return send(res, 200, game.publicView(doc.room, playerId, doc.seen));
}

module.exports = async function entry(req, res, code, action) {
  try {
    await handle(req, res, code, action);
  } catch (error) {
    if (error instanceof game.ClientError) return send(res, error.status, { error: error.message });
    console.error(error && error.message ? error.message : error);
    return send(res, 500, { error: 'Something went wrong. Try again.' });
  }
};
module.exports.usingRedis = usingRedis;
