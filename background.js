'use strict';

// Works in Chrome (service worker) and Firefox (event page).
const api = globalThis.browser ?? globalThis.chrome;

const BGG_API = 'https://boardgamegeek.com/xmlapi2';
const DAY = 24 * 60 * 60 * 1000;
const TTL_FOUND = 14 * DAY;
const TTL_NOT_FOUND = 3 * DAY;
const MIN_INTERVAL_MS = 2000; // be gentle with BGG: max one request every 2 s
const MAX_ATTEMPTS = 5;
const MAX_THING_IDS = 20; // BGG limit per /thing request

const cacheKey = (key) => `c:${key}`;
const overrideKey = (key) => `o:${key}`;

class BggError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Text helpers

function decodeEntities(s) {
  const once = (str) =>
    str.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
      const l = e.toLowerCase();
      if (l === 'amp') return '&';
      if (l === 'lt') return '<';
      if (l === 'gt') return '>';
      if (l === 'quot') return '"';
      if (l === 'apos') return "'";
      const code = l[1] === 'x' ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    });
  // BGG sometimes double-encodes (&amp;#039;)
  return once(once(s));
}

function normalize(s) {
  return String(s)
    .toLowerCase()
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function bigrams(s) {
  const t = s.replace(/ /g, '');
  const out = new Map();
  for (let i = 0; i < t.length - 1; i++) {
    const b = t.slice(i, i + 2);
    out.set(b, (out.get(b) || 0) + 1);
  }
  return out;
}

// Dice coefficient on character bigrams, 1 = identical.
function similarity(a, b) {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [k, v] of A) {
    inter += Math.min(v, B.get(k) || 0);
    total += v;
  }
  for (const v of B.values()) total += v;
  return total ? (2 * inter) / total : 0;
}

// "Abyss - Boîte bleue" -> ["Abyss - Boîte bleue", "Abyss"]
function queryVariants(title) {
  const t = title.replace(/\s+/g, ' ').trim();
  const variants = [t];
  for (const sep of [' - ', ' – ', ' — ', ':', ' (', ' + ']) {
    const i = t.indexOf(sep);
    if (i > 1) variants.push(t.slice(0, i).trim());
  }
  return [...new Set(variants.filter((v) => v.length >= 2))];
}

// ---------------------------------------------------------------------------
// Minimal XML reading (no DOMParser in Chrome service workers).
// BGG responses are simple and stable, so regexes are enough.

function parseAttrs(tagContent) {
  const out = {};
  for (const m of tagContent.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = decodeEntities(m[2]);
  return out;
}

function parseItems(xml) {
  return [...xml.matchAll(/<item\b([^>]*)>([\s\S]*?)<\/item>/g)].map((m) => ({
    attrs: parseAttrs(m[1]),
    body: m[2],
  }));
}

function tagsAttrs(body, name) {
  const re = new RegExp(`<${name}\\b([^>]*?)\\/?>`, 'g');
  return [...body.matchAll(re)].map((m) => parseAttrs(m[1]));
}

function firstValue(body, name) {
  return tagsAttrs(body, name)[0]?.value;
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function parseThingItem({ attrs, body }) {
  const names = tagsAttrs(body, 'name');
  const primary = names.find((n) => n.type === 'primary')?.value ?? names[0]?.value ?? '';
  const rank = tagsAttrs(body, 'rank').find((r) => r.name === 'boardgame');
  const rankValue = rank ? parseInt(rank.value, 10) : NaN;
  const thumb = body.match(/<thumbnail>([\s\S]*?)<\/thumbnail>/);
  return {
    id: parseInt(attrs.id, 10),
    type: attrs.type || 'boardgame',
    name: primary,
    year: num(firstValue(body, 'yearpublished')),
    minPlayers: num(firstValue(body, 'minplayers')),
    maxPlayers: num(firstValue(body, 'maxplayers')),
    minTime: num(firstValue(body, 'minplaytime')),
    maxTime: num(firstValue(body, 'maxplaytime')),
    rating: num(firstValue(body, 'average')),
    bayes: num(firstValue(body, 'bayesaverage')),
    votes: parseInt(firstValue(body, 'usersrated'), 10) || 0,
    weight: num(firstValue(body, 'averageweight')),
    rank: Number.isFinite(rankValue) ? rankValue : null,
    thumbnail: thumb ? decodeEntities(thumb[1].trim()) : null,
  };
}

// ---------------------------------------------------------------------------
// BGG requests: one global, throttled queue shared by every tab.

let queue = Promise.resolve();
let lastRequestAt = 0;

async function getToken() {
  const { token } = await api.storage.local.get('token');
  return (token || '').trim();
}

function bggFetch(path) {
  const run = async () => {
    const token = await getToken();
    if (!token) throw new BggError('NO_TOKEN');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const wait = lastRequestAt + MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();

      let res;
      try {
        res = await fetch(BGG_API + path, {
          headers: { Authorization: `Bearer ${token}` },
          credentials: 'omit',
        });
      } catch (e) {
        throw new BggError('NETWORK', String(e));
      }

      if (res.status === 200) return res.text();
      if (res.status === 401 || res.status === 403) throw new BggError('BAD_TOKEN');
      if (res.status === 202 || res.status === 429 || res.status >= 500) {
        await sleep(3000 * 2 ** Math.min(attempt, 3)); // 3, 6, 12, 24 s
        continue;
      }
      throw new BggError('HTTP', `HTTP ${res.status}`);
    }
    throw new BggError('RATE_LIMIT');
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function bggSearch(query, exact) {
  let path = `/search?query=${encodeURIComponent(query)}&type=boardgame,boardgameexpansion`;
  if (exact) path += '&exact=1';
  const xml = await bggFetch(path);
  const seen = new Set();
  const out = [];
  for (const { attrs, body } of parseItems(xml)) {
    const id = parseInt(attrs.id, 10);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      type: attrs.type,
      name: tagsAttrs(body, 'name')[0]?.value || '',
      year: num(firstValue(body, 'yearpublished')),
    });
  }
  return out;
}

async function bggThings(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += MAX_THING_IDS) {
    const chunk = ids.slice(i, i + MAX_THING_IDS);
    const xml = await bggFetch(`/thing?id=${chunk.join(',')}&stats=1`);
    out.push(...parseItems(xml).map(parseThingItem));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Matching an Okkazeo title to a BGG game

function score(candidate) {
  const typeFactor = candidate.type === 'boardgame' ? 1 : 0.9;
  return candidate.sim * candidate.sim * Math.log10(candidate.votes + 10) * typeFactor;
}

async function searchBestMatch(title) {
  const variants = queryVariants(title);
  for (let i = 0; i < variants.length; i++) {
    const query = variants[i];
    const qn = normalize(query);

    let results = await bggSearch(query, true);
    if (!results.length) results = await bggSearch(query, false);
    if (!results.length) continue;

    const scored = results.map((r) => ({ ...r, sim: similarity(qn, normalize(r.name)) }));
    let pool = scored.filter((r) => r.sim >= 0.999);
    if (!pool.length) {
      pool = scored
        .filter((r) => r.sim >= 0.6)
        .sort((a, b) => b.sim - a.sim)
        .slice(0, MAX_THING_IDS);
    }
    if (!pool.length) continue;

    const simById = new Map(pool.map((p) => [p.id, p.sim]));
    const things = await bggThings([...simById.keys()]);
    const candidates = things.map((t) => ({ ...t, sim: simById.get(t.id) ?? 0 }));
    if (!candidates.length) continue;

    candidates.sort((a, b) => score(b) - score(a));
    const best = candidates[0];
    return {
      status: 'ok',
      approx: i > 0 || best.sim < 0.999,
      ...best,
    };
  }
  return { status: 'notfound' };
}

// ---------------------------------------------------------------------------
// Cache + overrides

const inflight = new Map();

function isFresh(entry) {
  if (!entry || !entry.ts) return false;
  const ttl = entry.status === 'ok' ? TTL_FOUND : TTL_NOT_FOUND;
  return Date.now() - entry.ts < ttl;
}

async function resolveTitle(title) {
  const key = normalize(title);
  if (!key) return { status: 'notfound' };
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    const store = await api.storage.local.get([cacheKey(key), overrideKey(key)]);
    const cached = store[cacheKey(key)];
    if (isFresh(cached)) return cached;

    const override = store[overrideKey(key)];
    let result;
    if (override && override.bggId === 0) {
      result = { status: 'excluded' };
    } else if (override && override.bggId) {
      const [thing] = await bggThings([override.bggId]);
      result = thing ? { status: 'ok', manual: true, approx: false, ...thing } : { status: 'notfound' };
    } else {
      result = await searchBestMatch(title);
    }

    result.ts = Date.now();
    result.query = title;
    await api.storage.local.set({ [cacheKey(key)]: result });
    return result;
  })();

  inflight.set(key, p);
  try {
    return await p;
  } finally {
    inflight.delete(key);
  }
}

async function setOverride(title, bggId) {
  const key = normalize(title);
  if (!key) return { status: 'notfound' };
  await api.storage.local.remove(cacheKey(key));
  if (bggId === null || bggId === undefined) {
    await api.storage.local.remove(overrideKey(key));
  } else {
    await api.storage.local.set({ [overrideKey(key)]: { bggId, title, ts: Date.now() } });
  }
  return resolveTitle(title);
}

async function stats() {
  const all = await api.storage.local.get(null);
  const s = { cached: 0, found: 0, notFound: 0, overrides: 0 };
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('c:')) {
      s.cached++;
      if (v.status === 'ok') s.found++;
      else s.notFound++;
    } else if (k.startsWith('o:')) {
      s.overrides++;
    }
  }
  return s;
}

async function clearByPrefix(prefix) {
  const all = await api.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(prefix));
  if (keys.length) await api.storage.local.remove(keys);
  return keys.length;
}

// ---------------------------------------------------------------------------
// Messaging

async function handle(msg) {
  switch (msg?.type) {
    case 'lookup':
      return resolveTitle(String(msg.title || ''));
    case 'setOverride':
      return setOverride(String(msg.title || ''), msg.bggId);
    case 'testToken': {
      const results = await bggSearch('Catan', true);
      return { count: results.length };
    }
    case 'stats':
      return stats();
    case 'clearCache':
      return clearByPrefix('c:');
    case 'clearOverrides':
      await clearByPrefix('o:');
      return clearByPrefix('c:');
    case 'openOptions':
      await api.runtime.openOptionsPage();
      return true;
    default:
      throw new BggError('UNKNOWN_MESSAGE');
  }
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  handle(msg).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e?.code || 'ERROR', message: String(e?.message || e) })
  );
  return true; // async response
});

api.action.onClicked.addListener(() => api.runtime.openOptionsPage());

api.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install' && !(await getToken())) api.runtime.openOptionsPage();
});
