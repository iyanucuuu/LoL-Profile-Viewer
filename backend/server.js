require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const cheerio    = require('cheerio');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors({ origin: /^http:\/\/localhost(:\d+)?$/ }));
app.use(express.json());

const API_KEY  = process.env.RIOT_API_KEY;
const REGIONAL = 'https://europe.api.riotgames.com';
const PLATFORM = 'https://euw1.api.riotgames.com';
const riot     = axios.create({ headers: { 'X-Riot-Token': API_KEY } });

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Season 2026 start — 2026-01-08 00:00:00 UTC
const SEASON_START = 1767830400;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchWithRetry(url, maxAttempts = 6) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return (await riot.get(url)).data;
    } catch (err) {
      if (err.response?.status === 429 && i < maxAttempts - 1) {
        const wait = (parseInt(err.response.headers['retry-after'] ?? '12') + 2) * 1000;
        console.log(`[429] rate-limited, waiting ${Math.round(wait/1000)}s…`);
        await sleep(wait);
      } else {
        throw err;
      }
    }
  }
}

function slimMatch(m) {
  return {
    metadata: { matchId: m.metadata.matchId },
    info: {
      gameDuration: m.info.gameDuration,
      gameCreation: m.info.gameCreation,
      gameMode:     m.info.gameMode,
      queueId:      m.info.queueId ?? 0,
      participants: m.info.participants.map(p => ({
        puuid:                       p.puuid,
        summonerName:                p.summonerName   || '',
        riotIdGameName:              p.riotIdGameName || '',
        championName:                p.championName,
        teamId:                      p.teamId,
        teamPosition:                p.teamPosition   || '',
        kills: p.kills, deaths: p.deaths, assists: p.assists, win: p.win,
        totalMinionsKilled:          p.totalMinionsKilled          || 0,
        neutralMinionsKilled:        p.neutralMinionsKilled        || 0,
        goldEarned:                  p.goldEarned                  || 0,
        visionScore:                 p.visionScore                 || 0,
        totalDamageDealtToChampions: p.totalDamageDealtToChampions || 0,
        item0: p.item0||0, item1: p.item1||0, item2: p.item2||0,
        item3: p.item3||0, item4: p.item4||0, item5: p.item5||0, item6: p.item6||0,
        summoner1Id: p.summoner1Id || 0,
        summoner2Id: p.summoner2Id || 0,
        perks: p.perks ? {
          statPerks: p.perks.statPerks || {},
          styles: (p.perks.styles || []).map(s => ({
            description: s.description,
            style:       s.style,
            selections:  (s.selections || []).map(sel => ({ perk: sel.perk })),
          })),
        } : null,
      }))
    }
  };
}

async function loadCachedMatches(puuid) {
  const { data, error } = await supabase
    .from('lol_matches')
    .select('match_data')
    .eq('puuid', puuid)
    .order('game_creation', { ascending: false });

  if (error) { console.error('[DB] load error:', error.message); return []; }
  return (data || []).map(r => r.match_data);
}

async function saveMatches(puuid, matches) {
  if (!matches.length) return;
  const rows = matches.map(m => ({
    match_id:      m.metadata.matchId,
    puuid,
    match_data:    m,
    game_creation: m.info.gameCreation,
  }));
  const { error } = await supabase
    .from('lol_matches')
    .upsert(rows, { onConflict: 'match_id,puuid', ignoreDuplicates: true });
  if (error) console.error('[DB] save error:', error.message);
  else console.log(`[DB] saved ${rows.length} matches for ${puuid.slice(0,8)}…`);
}

async function loadCachedTimeline(matchId, puuid) {
  const { data, error } = await supabase
    .from('lol_timelines')
    .select('events')
    .eq('match_id', matchId)
    .eq('puuid', puuid)
    .single();
  if (error || !data) return null;
  return data.events;
}

async function saveTimeline(matchId, puuid, events) {
  const { error } = await supabase
    .from('lol_timelines')
    .upsert({ match_id: matchId, puuid, events }, { onConflict: 'match_id,puuid', ignoreDuplicates: true });
  if (error) console.error('[DB] timeline save error:', error.message);
  else console.log(`[DB] cached timeline ${matchId.slice(-6)} for ${puuid.slice(0,8)}…`);
}

async function getNewestCachedId(puuid) {
  const { data } = await supabase
    .from('lol_matches')
    .select('match_id')
    .eq('puuid', puuid)
    .order('game_creation', { ascending: false })
    .limit(1);
  return data?.[0]?.match_id ?? null;
}

let ddVersion = '15.10.1';
axios.get('https://ddragon.leagueoflegends.com/api/versions.json')
  .then(r => { ddVersion = r.data[0]; console.log(`DD version: ${ddVersion}`); })
  .catch(() => console.log(`DD version fallback: ${ddVersion}`));

app.get('/api/summoner/:gameName/:tagLine', async (req, res) => {
  try {
    const { gameName, tagLine } = req.params;

    const accountRes = await riot.get(
      `${REGIONAL}/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
    const { puuid } = accountRes.data;

    const [summonerRes, rankedRes, masteryRes, ddRes] = await Promise.all([
      riot.get(`${PLATFORM}/lol/summoner/v4/summoners/by-puuid/${puuid}`),
      riot.get(`${PLATFORM}/lol/league/v4/entries/by-puuid/${puuid}`),
      riot.get(`${PLATFORM}/lol/champion-mastery/v4/champion-masteries/by-puuid/${puuid}`),
      axios.get(`https://ddragon.leagueoflegends.com/cdn/${ddVersion}/data/en_US/champion.json`)
    ]);

    const champById = {};
    for (const champ of Object.values(ddRes.data.data)) {
      champById[champ.key] = champ.id;
    }

    const mastery = masteryRes.data.map(m => ({
      ...m,
      championName: champById[m.championId] || null
    }));

    res.json({
      account:  accountRes.data,
      summoner: summonerRes.data,
      ranked:   rankedRes.data,
      mastery,
      ddVersion
    });
  } catch (err) {
    const status  = err.response?.status || 500;
    const message = err.response?.data?.status?.message || err.message;
    res.status(status).json({ error: message });
  }
});

app.get('/api/matches/:puuid/season', async (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const { puuid } = req.params;
  const send      = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const cached = await loadCachedMatches(puuid);
    if (cached.length > 0) {
      console.log(`[DB] streaming ${cached.length} cached matches for ${puuid.slice(0,8)}…`);
      send({ type: 'total', count: cached.length });
      for (const m of cached) {
        send({ type: 'match', match: m });
      }
    }

    const newestId = cached.length > 0
      ? cached[0].metadata.matchId
      : null;

    let newIds = [];
    let offset = 0;

    while (true) {
      if (aborted) { res.end(); return; }

      const ids = await fetchWithRetry(
        `${REGIONAL}/lol/match/v5/matches/by-puuid/${puuid}/ids` +
        `?queue=420&startTime=${SEASON_START}&count=100&start=${offset}`
      );

      if (newestId) {
        const anchorIdx = ids.indexOf(newestId);
        if (anchorIdx !== -1) {
          newIds = [...newIds, ...ids.slice(0, anchorIdx)];
          break;
        }
      }

      newIds = [...newIds, ...ids];
      if (ids.length < 100) break;
      offset += 100;
      await sleep(400);
    }

    console.log(`[Riot] ${newIds.length} new matches for ${puuid.slice(0,8)}…`);

    if (newIds.length === 0) {
      send({ type: 'total', count: cached.length });
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }

    send({ type: 'total', count: cached.length + newIds.length });

    const BATCH = 2, DELAY = 2500;

    for (let i = 0; i < newIds.length; i += BATCH) {
      if (aborted) { res.end(); return; }

      const batchIds  = newIds.slice(i, i + BATCH);
      const batchData = await Promise.all(
        batchIds.map(id => fetchWithRetry(`${REGIONAL}/lol/match/v5/matches/${id}`))
      );

      const toSave = [];
      for (const match of batchData) {
        if (match.info.gameDuration > 900) {
          const slim = slimMatch(match);
          toSave.push(slim);
          send({ type: 'match', match: slim });
        }
      }

      if (toSave.length > 0) {
        saveMatches(puuid, toSave).catch(e => console.error('[DB] save error:', e.message));
      }

      if (i + BATCH < newIds.length) await sleep(DELAY);
    }

    res.write('event: done\ndata: {}\n\n');
  } catch (err) {
    const msg = err.response?.data?.status?.message || err.message;
    res.write(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
  }

  res.end();
});

app.get('/api/matches/update-perks/:puuid', async (req, res) => {
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const { puuid } = req.params;
  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    const { data: rows, error } = await supabase
      .from('lol_matches')
      .select('match_id, match_data')
      .eq('puuid', puuid);

    if (error) { send({ type: 'error', message: error.message }); res.end(); return; }

    const needsUpdate = (rows || []).filter(r => {
      const p0 = r.match_data?.info?.participants?.[0];
      return !p0?.perks;
    });

    send({ type: 'total', count: needsUpdate.length });
    if (needsUpdate.length === 0) {
      res.write('event: done\ndata: {}\n\n');
      res.end();
      return;
    }

    const BATCH = 2, DELAY = 2500;
    let done = 0;

    for (let i = 0; i < needsUpdate.length; i += BATCH) {
      if (aborted) { res.end(); return; }

      const batch = needsUpdate.slice(i, i + BATCH);
      const fetched = await Promise.all(
        batch.map(r => fetchWithRetry(`${REGIONAL}/lol/match/v5/matches/${r.match_id}`)
          .catch(() => null))
      );

      for (let j = 0; j < batch.length; j++) {
        const full = fetched[j];
        if (!full) continue;

        const slim = slimMatch(full);
        await supabase
          .from('lol_matches')
          .update({ match_data: slim })
          .eq('match_id', batch[j].match_id)
          .eq('puuid', puuid);

        done++;
        send({ type: 'progress', done, total: needsUpdate.length });
      }

      if (i + BATCH < needsUpdate.length) await sleep(DELAY);
    }

    res.write('event: done\ndata: {}\n\n');
  } catch (err) {
    send({ type: 'error', message: err.message });
  }
  res.end();
});

app.post('/api/timelines/batch', async (req, res) => {
  try {
    const { matchIds, puuid } = req.body;
    if (!Array.isArray(matchIds) || !puuid) return res.json({ timelines: [] });

    const { data, error } = await supabase
      .from('lol_timelines')
      .select('match_id, events')
      .eq('puuid', puuid)
      .in('match_id', matchIds);

    if (error) { console.error('[DB] batch timeline error:', error.message); return res.json({ timelines: [] }); }
    res.json({ timelines: data || [] });
  } catch (err) {
    res.json({ timelines: [] });
  }
});

app.get('/api/timeline/:matchId', async (req, res) => {
  try {
    const { matchId } = req.params;
    const { puuid }   = req.query;

    const cached = await loadCachedTimeline(matchId, puuid);
    if (cached) {
      return res.json({ events: cached, cached: true });
    }

    const tl  = await fetchWithRetry(
      `${REGIONAL}/lol/match/v5/matches/${matchId}/timeline`
    );
    const pid = tl.info?.participants?.find(p => p.puuid === puuid)?.participantId;
    if (!pid) return res.json({ events: [], cached: false });

    const events = [];
    for (const frame of (tl.info?.frames ?? [])) {
      for (const e of (frame.events ?? [])) {
        if (e.participantId === pid &&
            (e.type === 'ITEM_PURCHASED' || e.type === 'ITEM_SOLD' || e.type === 'ITEM_UNDO')) {
          events.push({ type: e.type, itemId: e.itemId, ts: e.timestamp });
        }
      }
    }

    if (puuid) saveTimeline(matchId, puuid, events).catch(() => {});
    res.json({ events, cached: false });
  } catch (err) {
    const status  = err.response?.status || 500;
    const message = err.response?.data?.status?.message || err.message;
    res.status(status).json({ error: message });
  }
});

const metaCache = new Map();
const META_TTL  = 60 * 60 * 1000;
const OPGG_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124';

async function scrapeOpggBuild(champion, position) {
  const pos  = position?.toLowerCase() || 'adc';
  const url  = `https://www.op.gg/champions/${champion.toLowerCase()}/build/${pos}`;
  const html = (await axios.get(url, { headers: { 'User-Agent': OPGG_UA }, timeout: 10000 })).data;
  const $    = cheerio.load(html);

  let skillOrder = null, skillWr = null, skillPick = null;
  $('table').each((i, t) => {
    const txt = $(t).text();
    if (txt.includes('Skill Order')) {
      const m = txt.match(/([QWER]{10,20})\s*([\d.]+)%[^%]*([\d.]+)%/);
      if (m) { skillOrder = m[1]; skillPick = parseFloat(m[2]); skillWr = parseFloat(m[3]); }
    }
  });

  const metaDesc = $('meta[name="description"]').attr('content') || '';
  const wrMatch  = metaDesc.match(/([\d.]+)%\s*win/i);
  const globalWr = wrMatch ? parseFloat(wrMatch[1]) : null;

  return { skillOrder, skillWr, skillPick, globalWr };
}

async function scrapeOpggCounters(champion, position) {
  const pos  = position?.toLowerCase() || 'adc';
  const url  = `https://www.op.gg/champions/${champion.toLowerCase()}/counter/${pos}`;
  const html = (await axios.get(url, { headers: { 'User-Agent': OPGG_UA }, timeout: 10000 })).data;
  const $    = cheerio.load(html);

  const champNames = $('img[src*="champion"]')
    .map((_, el) => $(el).attr('alt'))
    .get()
    .filter(Boolean);

  const tableText = $('table').first().text();
  const pcts      = (tableText.match(/(\d+\.\d+)%/g) || []).map(p => parseFloat(p));

  const counters = [];
  for (let i = 0; i < champNames.length && i * 3 + 2 < pcts.length; i++) {
    counters.push({
      champion: champNames[i],
      winRate:  pcts[i * 3],
      pickRate: pcts[i * 3 + 1],
      banRate:  pcts[i * 3 + 2],
    });
  }

  const sorted  = [...counters].sort((a, b) => a.winRate - b.winRate);
  return {
    hardest: sorted.slice(0, 10),
    easiest: sorted.slice(-10).reverse(),
  };
}

app.get('/api/meta/:champion/:position', async (req, res) => {
  const { champion, position } = req.params;
  const key    = `${champion}_${position}`;
  const cached = metaCache.get(key);
  if (cached && Date.now() - cached.ts < META_TTL) return res.json({ ...cached.data, cached: true });

  try {
    const [build, counters] = await Promise.all([
      scrapeOpggBuild(champion, position),
      scrapeOpggCounters(champion, position),
    ]);
    const data = { champion, position, ...build, ...counters };
    metaCache.set(key, { ts: Date.now(), data });
    res.json(data);
  } catch (err) {
    if (cached) return res.json({ ...cached.data, cached: true, stale: true });
    console.error('[META]', champion, err.message);
    res.status(502).json({ error: err.message });
  }
});

app.post('/api/analytics/item-matchup', async (req, res) => {
  try {
    const { puuid, championName, itemId } = req.body;
    if (!puuid || !championName || !itemId) return res.status(400).json({ error: 'Missing params' });

    const { data: rows, error } = await supabase
      .from('lol_matches')
      .select('match_data')
      .eq('puuid', puuid);

    if (error) return res.status(500).json({ error: error.message });

    const result = new Map();

    for (const row of rows || []) {
      const m = row.match_data;
      if (!m?.info) continue;
      const me = m.info.participants.find(p => p.puuid === puuid);
      if (!me || me.championName !== championName) continue;

      const hasItem = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6]
        .includes(Number(itemId));
      if (!hasItem) continue;

      const opp = m.info.participants.find(
        p => p.teamId !== me.teamId && p.teamPosition === me.teamPosition && p.teamPosition
      );
      if (!opp) continue;

      const key = opp.championName;
      if (!result.has(key)) result.set(key, { games: 0, wins: 0 });
      const e = result.get(key);
      e.games++;
      if (me.win) e.wins++;
    }

    const matchups = [...result.entries()]
      .map(([enemy, { games, wins }]) => ({
        enemy, games, wins,
        wr: Math.round((wins / games) * 100),
      }))
      .filter(m => m.games >= 2)
      .sort((a, b) => b.wr - a.wr);

    res.json({ championName, itemId, matchups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/matches/:puuid', async (req, res) => {
  try {
    const { puuid } = req.params;
    const count = parseInt(req.query.count) || 10;
    const start = parseInt(req.query.start) || 0;

    const matchIds = await fetchWithRetry(
      `${REGIONAL}/lol/match/v5/matches/by-puuid/${puuid}/ids?count=${count}&start=${start}`
    );
    const matches = await Promise.all(
      matchIds.map(id => fetchWithRetry(`${REGIONAL}/lol/match/v5/matches/${id}`))
    );
    res.json(matches);
  } catch (err) {
    const status  = err.response?.status || 500;
    const message = err.response?.data?.status?.message || err.message;
    res.status(status).json({ error: message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
