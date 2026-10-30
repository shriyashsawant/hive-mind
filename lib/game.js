// Hive Mind game rules, shared by the Vercel API functions.
'use strict';
const crypto = require('node:crypto');

const ROUND_MS = 30_000;
const ROUNDS = 8;
const MAX_PLAYERS = 12;
const HOST_GRACE_MS = 12_000;
const CODE_CHARS = 'BCDFGHJKLMNPQRSTVWXYZ';
const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);
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

class ClientError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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

function cleanAnswer(value) {
  return typeof value === 'string' ? stripInvisible(value).replace(/\s+/g, ' ').trim().slice(0, 80) : '';
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

function newPublicId() {
  return crypto.randomBytes(9).toString('base64url');
}

function randomCode() {
  return Array.from({ length: 4 }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
}

function playerFor(room, id) {
  if (typeof id !== 'string' || !id) return undefined;
  return room.players.find(player => player.id === id);
}

function answerFor(room, id) {
  return Object.prototype.hasOwnProperty.call(room.answers || {}, id) ? room.answers[id] : undefined;
}

function lockedCount(room) {
  return room.players.filter(player => { const answer = answerFor(room, player.id); return answer && answer.locked; }).length;
}

function newRoom(code, hostId, name) {
  const now = Date.now();
  return {
    code, hostId,
    players: [{ id: hostId, pid: newPublicId(), name, score: 0, roundPoints: 0 }],
    phase: 'lobby', round: 0, prompts: [], deadlineAt: null, answers: {}, lastReveal: null,
    createdAt: now, updatedAt: now
  };
}

function addPlayer(room, playerId, name) {
  if (room.players.length >= MAX_PLAYERS) throw new ClientError(409, 'This hive is full. Rooms can hold up to 12 players.');
  if (room.players.some(item => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new ClientError(409, 'That nickname is already in this room. Try another one.');
  const player = { id: playerId, pid: newPublicId(), name, score: 0, roundPoints: 0 };
  room.players.push(player);
  return player;
}

// Take a player out of the room. The host role passes to the longest-standing player.
function removePlayer(room, playerId) {
  const index = room.players.findIndex(player => player.id === playerId);
  if (index < 0) return false;
  room.players.splice(index, 1);
  if (Object.prototype.hasOwnProperty.call(room.answers || {}, playerId)) delete room.answers[playerId];
  if (!room.players.length) {
    room.phase = 'closed';
    room.closedReason = 'empty';
  } else {
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    if (room.phase === 'playing' && lockedCount(room) >= room.players.length) finishRound(room);
  }
  room.updatedAt = Date.now();
  return true;
}

function closeRoom(room) {
  room.phase = 'closed';
  room.closedReason = 'host';
  room.deadlineAt = null;
  room.updatedAt = Date.now();
}

function wasRemoved(room, playerId) {
  return Array.isArray(room.removed) && room.removed.includes(playerId);
}

function revealGroups(room) {
  const groups = new Map();
  const noAnswer = [];
  for (const player of room.players) {
    const answer = answerFor(room, player.id);
    const normalized = answer && answer.text ? normalizeAnswer(answer.text) : '';
    if (!normalized) { noAnswer.push(player.name); continue; }
    if (!groups.has(normalized)) groups.set(normalized, { normalized, display: answer.text.trim(), players: [] });
    groups.get(normalized).players.push(player.name);
  }
  const sorted = Array.from(groups.values()).sort((a, b) => b.players.length - a.players.length || a.normalized.localeCompare(b.normalized));
  const highest = sorted.length ? sorted[0].players.length : 0;
  return { groups: sorted.map(group => ({ ...group, hive: group.players.length === highest && highest > 1 })), noAnswer };
}

function finishRound(room) {
  if (room.phase !== 'playing') return false;
  const { groups, noAnswer } = revealGroups(room);
  for (const player of room.players) player.roundPoints = 0;
  for (const group of groups) {
    const points = group.players.length > 1 ? group.players.length : 0;
    for (const name of group.players) {
      const player = room.players.find(item => item.name === name);
      if (player) { player.score += points; player.roundPoints = points; }
    }
  }
  room.lastReveal = { round: room.round, groups, noAnswer, revealedAt: Date.now() };
  room.deadlineAt = null;
  room.phase = room.round === ROUNDS ? 'finished' : 'reveal';
  room.updatedAt = Date.now();
  return true;
}

function advanceIfExpired(room) {
  if (room.phase === 'playing' && room.deadlineAt && Date.now() >= room.deadlineAt) return finishRound(room);
  return false;
}

function startGame(room) {
  room.prompts = shuffle(PROMPTS).slice(0, ROUNDS);
  room.round = 1;
  room.phase = 'playing';
  room.deadlineAt = Date.now() + ROUND_MS;
  room.answers = {};
  room.lastReveal = null;
  for (const player of room.players) { player.score = 0; player.roundPoints = 0; }
  room.updatedAt = Date.now();
}

function nextRound(room) {
  room.round += 1;
  room.phase = 'playing';
  room.deadlineAt = Date.now() + ROUND_MS;
  room.answers = {};
  room.updatedAt = Date.now();
}

// What one player is allowed to see. Secret ids and other players' answers never leave the server.
function publicView(room, playerId, seen) {
  const now = Date.now();
  const self = playerFor(room, playerId);
  const host = playerFor(room, room.hostId);
  const online = player => now - Number((seen && seen[player.pid]) || 0) <= HOST_GRACE_MS;
  const hasReveal = room.phase === 'reveal' || room.phase === 'finished';
  const ownAnswer = room.phase === 'playing' && self && answerFor(room, self.id) ? answerFor(room, self.id).text : '';
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    roundCount: ROUNDS,
    prompt: room.phase === 'lobby' || room.phase === 'closed' ? null : room.prompts[room.round - 1] || null,
    closedReason: room.phase === 'closed' ? room.closedReason || 'host' : null,
    deadlineAt: room.deadlineAt,
    serverNow: now,
    hostId: host ? host.pid : null,
    hostConnected: Boolean(host && online(host)),
    isHost: Boolean(self && self.id === room.hostId),
    selfId: self ? self.pid : null,
    selfName: self ? self.name : null,
    players: room.players.map(player => ({
      id: player.pid,
      name: player.name,
      score: player.score,
      roundPoints: player.roundPoints,
      isHost: player.id === room.hostId,
      connected: online(player),
      locked: Boolean(answerFor(room, player.id) && answerFor(room, player.id).locked)
    })),
    lockedCount: lockedCount(room),
    playerCount: room.players.length,
    ownAnswer,
    reveal: hasReveal ? room.lastReveal : null,
    winners: room.phase === 'finished' ? room.players.filter(player => player.score === Math.max(...room.players.map(p => p.score))).map(player => player.name) : []
  };
}

module.exports = {
  ROUND_MS, ROUNDS, PROMPTS, ClientError, cleanName, cleanAnswer, validPlayerId, normalizeAnswer,
  randomCode, playerFor, answerFor, lockedCount, newRoom, addPlayer, removePlayer, closeRoom, wasRemoved, finishRound, advanceIfExpired, startGame, nextRound, publicView
};
