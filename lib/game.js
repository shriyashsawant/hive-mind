// Hive Mind game rules, shared by the Vercel API functions.
'use strict';
const crypto = require('node:crypto');

const ROUND_MS = 30_000;
const ROUNDS = 8;
const ROUND_CHOICES = [5, 8, 12];
const SECOND_CHOICES = [20, 30, 45];
const REACTIONS = ['😂', '🔥', '🤯', '👏', '😱', '🐝'];
const MAX_CUSTOM = 30;
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

const PACKS = {
  mixed: { name: 'Mixed bag', prompts: PROMPTS },
  food: { name: 'Food & drink', prompts: [
    'A pizza topping', 'A breakfast cereal', 'A fruit that is red', 'Something you put on toast', 'A fast food chain',
    'A food you eat with chopsticks', 'A spicy food', 'A flavor of ice cream', 'A drink with bubbles', 'Something in a salad',
    'A dessert served warm', 'A food that is orange', 'A type of pasta', 'Something you dip fries in', 'A street food',
    'A snack at the movies', 'A food from Italy', 'A sandwich filling', 'A hot drink', 'A food you eat at a birthday party',
    'A vegetable that is green', 'Something you grill', 'A type of cheese', 'A food that is crunchy'
  ] },
  screen: { name: 'Movies & TV', prompts: [
    'A superhero', 'A Disney movie', 'A famous wizard', 'A TV show about friends', 'A movie villain',
    'A cartoon dog', 'A horror movie monster', 'A famous movie car', 'A movie about space', 'A princess',
    'A reality TV show', 'A movie with a talking animal', 'A famous detective', 'A streaming service', 'A sitcom',
    'A movie snack', 'An animated movie', 'A movie set at school', 'A famous robot', 'A movie everyone quotes',
    'A video game character', 'A famous movie director', 'A show you binge watch', 'A movie with a sequel'
  ] },
  school: { name: 'School life', prompts: [
    'A school subject', 'Something in a pencil case', 'An excuse for late homework', 'A school club', 'A school lunch food',
    'Something on a classroom wall', 'A reason to visit the principal', 'A sport in gym class', 'A field trip place', 'Something in a locker',
    'A school supply', 'A word teachers say a lot', 'A science experiment item', 'A thing you do in study hall', 'A college major',
    'A way to get to school', 'A test you dread', 'Something in a backpack', 'A school event', 'A thing you doodle in class',
    'A language people learn', 'A playground game', 'A reason to skip class', 'A graduation gift'
  ] },
  nature: { name: 'Animals & nature', prompts: [
    'A farm animal', 'An animal with stripes', 'A bird', 'An animal in the ocean', 'A pet',
    'A flower', 'An insect', 'A tree', 'An animal that hops', 'A big cat',
    'Something you see at the beach', 'A type of weather', 'An animal that is slow', 'A reptile', 'An animal at the zoo',
    'Something in a forest', 'A dog breed', 'An animal that can fly', 'A planet', 'A season',
    'A mountain animal', 'Something that glows at night', 'An animal that is pink', 'A natural wonder'
  ] }
};

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

function defaultSettings() {
  return { rounds: ROUNDS, seconds: ROUND_MS / 1000, pack: 'mixed', custom: [] };
}

function settingsOf(room) {
  return { ...defaultSettings(), ...(room.settings || {}) };
}

// Host settings, validated against fixed choices.
function applySettings(room, input) {
  const next = settingsOf(room);
  if (input.rounds !== undefined) {
    if (!ROUND_CHOICES.includes(Number(input.rounds))) throw new ClientError(400, 'Pick 5, 8 or 12 rounds.');
    next.rounds = Number(input.rounds);
  }
  if (input.seconds !== undefined) {
    if (!SECOND_CHOICES.includes(Number(input.seconds))) throw new ClientError(400, 'Pick a 20, 30 or 45 second timer.');
    next.seconds = Number(input.seconds);
  }
  if (input.pack !== undefined) {
    if (input.pack !== 'custom' && !Object.prototype.hasOwnProperty.call(PACKS, input.pack)) throw new ClientError(400, 'Pick one of the prompt packs.');
    next.pack = input.pack;
  }
  if (input.custom !== undefined) {
    if (!Array.isArray(input.custom)) throw new ClientError(400, 'Custom prompts must be a list.');
    const seen = new Set();
    next.custom = input.custom.map(item => cleanAnswer(item)).filter(item => {
      const key = item.toLocaleLowerCase();
      if (!item || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_CUSTOM);
  }
  room.settings = next;
  room.updatedAt = Date.now();
}

function promptPool(settings) {
  const base = shuffle(PACKS.mixed.prompts);
  if (settings.pack === 'custom') {
    const custom = shuffle(settings.custom || []);
    const used = new Set(custom.map(item => item.toLocaleLowerCase()));
    return custom.concat(base.filter(item => !used.has(item.toLocaleLowerCase())));
  }
  const pack = shuffle((PACKS[settings.pack] || PACKS.mixed).prompts);
  const used = new Set(pack.map(item => item.toLocaleLowerCase()));
  return pack.concat(base.filter(item => !used.has(item.toLocaleLowerCase())));
}

function newRoom(code, hostId, name) {
  const now = Date.now();
  return {
    settings: defaultSettings(),
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
  room.history = [...(room.history || []), { groups: groups.map(group => group.players) }].slice(-12);
  room.deadlineAt = null;
  room.phase = room.round >= settingsOf(room).rounds ? 'finished' : 'reveal';
  room.updatedAt = Date.now();
  return true;
}

function advanceIfExpired(room) {
  if (room.phase === 'playing' && room.deadlineAt && Date.now() >= room.deadlineAt) return finishRound(room);
  return false;
}

function startGame(room) {
  const settings = settingsOf(room);
  const pool = promptPool(settings);
  room.prompts = pool.slice(0, settings.rounds);
  room.spare = pool.slice(settings.rounds, settings.rounds + 10);
  room.history = [];
  room.round = 1;
  room.phase = 'playing';
  room.deadlineAt = Date.now() + settings.seconds * 1000;
  room.answers = {};
  room.lastReveal = null;
  for (const player of room.players) { player.score = 0; player.roundPoints = 0; }
  room.updatedAt = Date.now();
}

function nextRound(room) {
  room.round += 1;
  room.phase = 'playing';
  room.deadlineAt = Date.now() + settingsOf(room).seconds * 1000;
  room.answers = {};
  room.updatedAt = Date.now();
}

// Swap the current prompt for a fresh one and restart the round clock.
function skipPrompt(room) {
  const used = new Set((room.prompts || []).map(item => item.toLocaleLowerCase()));
  let spare = (room.spare || []).filter(item => !used.has(item.toLocaleLowerCase()));
  if (!spare.length) spare = shuffle(PROMPTS).filter(item => !used.has(item.toLocaleLowerCase()));
  if (!spare.length) throw new ClientError(409, 'There are no more prompts to swap in.');
  room.prompts[room.round - 1] = spare[0];
  room.spare = spare.slice(1);
  room.answers = {};
  room.deadlineAt = Date.now() + settingsOf(room).seconds * 1000;
  room.updatedAt = Date.now();
}

function addReaction(room, player, emoji) {
  if (!REACTIONS.includes(emoji)) throw new ClientError(400, 'Pick one of the reactions.');
  const now = Date.now();
  if (player.lastReactAt && now - player.lastReactAt < 500) throw new ClientError(429, 'Easy there! One reaction at a time.');
  player.lastReactAt = now;
  room.reactions = [...(room.reactions || []).filter(item => now - item.at < 8000), { id: newPublicId(), by: player.name, e: emoji, at: now }].slice(-16);
}

// Fun titles for the final screen, worked out from every round's matches.
function awards(room) {
  const history = room.history || [];
  if (!history.length) return [];
  const matched = {}, unique = {}, pairs = {};
  for (const round of history) {
    for (const names of round.groups) {
      if (names.length > 1) {
        names.forEach(name => { matched[name] = (matched[name] || 0) + 1; });
        for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) {
          const key = JSON.stringify([names[i], names[j]].sort());
          pairs[key] = (pairs[key] || 0) + 1;
        }
      } else names.forEach(name => { unique[name] = (unique[name] || 0) + 1; });
    }
  }
  const leaders = counts => {
    const best = Math.max(0, ...Object.values(counts));
    return best ? { names: Object.keys(counts).filter(name => counts[name] === best).slice(0, 3), count: best } : null;
  };
  const list = [];
  const queen = leaders(matched);
  if (queen) list.push({ id: 'queen', title: 'Queen Bee', names: queen.names, detail: 'Matched the hive in ' + queen.count + (queen.count === 1 ? ' round' : ' rounds') });
  const pair = leaders(pairs);
  if (pair) list.push({ id: 'soulmates', title: 'Hive Soulmates', names: JSON.parse(leaders(pairs).names[0]), detail: 'Said the same thing ' + pair.count + (pair.count === 1 ? ' time' : ' times') });
  const lone = leaders(unique);
  if (lone) list.push({ id: 'lone', title: 'Lone Bee', names: lone.names, detail: lone.count + (lone.count === 1 ? ' answer' : ' answers') + ' nobody else thought of' });
  return list;
}

// What one player is allowed to see. Secret ids and other players' answers never leave the server.
function publicView(room, playerId, seen) {
  const now = Date.now();
  const self = playerFor(room, playerId);
  const host = playerFor(room, room.hostId);
  const online = player => now - Number((seen && seen[player.pid]) || 0) <= HOST_GRACE_MS;
  const hasReveal = room.phase === 'reveal' || room.phase === 'finished';
  const ownAnswer = room.phase === 'playing' && self && answerFor(room, self.id) ? answerFor(room, self.id).text : '';
  const settings = settingsOf(room);
  const isHost = Boolean(self && self.id === room.hostId);
  return {
    roundSeconds: settings.seconds,
    settings: { rounds: settings.rounds, seconds: settings.seconds, pack: settings.pack, packName: settings.pack === 'custom' ? 'Your own prompts' : PACKS[settings.pack].name, customCount: settings.custom.length, custom: isHost ? settings.custom : undefined },
    packs: Object.keys(PACKS).map(id => ({ id, name: PACKS[id].name })),
    reactions: (room.reactions || []).filter(item => now - item.at < 8000).map(item => ({ id: item.id, by: item.by, e: item.e })),
    awards: room.phase === 'finished' ? awards(room) : [],
    code: room.code,
    phase: room.phase,
    round: room.round,
    roundCount: settings.rounds,
    prompt: room.phase === 'lobby' || room.phase === 'closed' ? null : room.prompts[room.round - 1] || null,
    closedReason: room.phase === 'closed' ? room.closedReason || 'host' : null,
    deadlineAt: room.deadlineAt,
    serverNow: now,
    hostId: host ? host.pid : null,
    hostConnected: Boolean(host && online(host)),
    isHost,
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
  ROUND_MS, ROUNDS, PROMPTS, PACKS, applySettings, skipPrompt, addReaction, awards, ClientError, cleanName, cleanAnswer, validPlayerId, normalizeAnswer,
  randomCode, playerFor, answerFor, lockedCount, newRoom, addPlayer, removePlayer, closeRoom, wasRemoved, finishRound, advanceIfExpired, startGame, nextRound, publicView
};
