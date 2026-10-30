// Room storage. Uses Upstash Redis (set up through the Vercel Marketplace) when its
// environment variables exist, and an in-process map for local development otherwise.
'use strict';

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const TTL_SECONDS = 6 * 60 * 60;
const roomKey = code => 'hm:room:' + code;
const seenKey = code => 'hm:seen:' + code;

// Write a new room version only if nobody else saved in between.
const CAS_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if not cur then return -1 end
local v = tonumber(string.match(cur, '^(%d+)|'))
if v ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1`;

function encode(version, room) { return version + '|' + JSON.stringify(room); }
function decode(raw) {
  if (!raw) return null;
  const cut = raw.indexOf('|');
  return { version: Number(raw.slice(0, cut)), room: JSON.parse(raw.slice(cut + 1)) };
}
function pairsToObject(list) {
  const out = {};
  for (let i = 0; Array.isArray(list) && i < list.length; i += 2) out[list[i]] = list[i + 1];
  return out;
}

async function redis(path, body) {
  const response = await fetch(REDIS_URL.replace(/\/$/, '') + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error('Storage error');
  return data;
}
async function command(...args) { return (await redis('', args)).result; }
async function pipeline(commands) {
  const results = await redis('/pipeline', commands);
  return results.map(item => { if (item.error) throw new Error('Storage error'); return item.result; });
}

const redisStore = {
  async create(code, room) {
    return (await command('SET', roomKey(code), encode(1, room), 'NX', 'EX', TTL_SECONDS)) === 'OK';
  },
  async load(code, seenPid) {
    const commands = [['GET', roomKey(code)]];
    if (seenPid) commands.push(['HSET', seenKey(code), seenPid, String(Date.now())]);
    commands.push(['HGETALL', seenKey(code)]);
    const results = await pipeline(commands);
    const doc = decode(results[0]);
    return doc ? { ...doc, seen: pairsToObject(results[results.length - 1]) } : null;
  },
  async save(code, version, room) {
    const result = await command('EVAL', CAS_SCRIPT, '2', roomKey(code), seenKey(code), String(version), encode(version + 1, room), String(TTL_SECONDS));
    return Number(result) === 1;
  },
  async touch(code, pid) {
    await pipeline([['HSET', seenKey(code), pid, String(Date.now())], ['EXPIRE', seenKey(code), String(TTL_SECONDS)]]);
  },
  async hit(key, windowSeconds) {
    const results = await pipeline([['INCR', 'hm:rl:' + key], ['EXPIRE', 'hm:rl:' + key, String(windowSeconds), 'NX']]);
    return Number(results[0]);
  }
};

const memory = { rooms: new Map(), seen: new Map(), hits: new Map() };
const memoryStore = {
  async create(code, room) {
    if (memory.rooms.has(code)) return false;
    memory.rooms.set(code, encode(1, room));
    return true;
  },
  async load(code, seenPid) {
    if (seenPid) await memoryStore.touch(code, seenPid);
    const doc = decode(memory.rooms.get(code));
    return doc ? { ...doc, seen: { ...(memory.seen.get(code) || {}) } } : null;
  },
  async save(code, version, room) {
    const doc = decode(memory.rooms.get(code));
    if (!doc || doc.version !== version) return false;
    memory.rooms.set(code, encode(version + 1, room));
    return true;
  },
  async touch(code, pid) {
    if (!memory.seen.has(code)) memory.seen.set(code, {});
    memory.seen.get(code)[pid] = String(Date.now());
  },
  async hit(key, windowSeconds) {
    const now = Date.now();
    const entry = memory.hits.get(key);
    if (!entry || now - entry.start > windowSeconds * 1000) { memory.hits.set(key, { start: now, count: 1 }); return 1; }
    entry.count += 1;
    return entry.count;
  }
};

const usingRedis = Boolean(REDIS_URL && REDIS_TOKEN);
module.exports = { store: usingRedis ? redisStore : memoryStore, usingRedis };
