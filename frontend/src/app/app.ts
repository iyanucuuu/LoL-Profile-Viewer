import { Component, ChangeDetectorRef, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule }  from '@angular/forms';
import { RiotApiService, SummonerProfile, Match, ChampionStat, MasteryEntry } from './services/riot-api';
import { ProfileCard }      from './components/profile-card/profile-card';
import { RankedStats }      from './components/ranked-stats/ranked-stats';
import { MatchHistory }     from './components/match-history/match-history';
import { ChampionMastery }  from './components/champion-mastery/champion-mastery';
import { ChampionDetail }   from './components/champion-detail/champion-detail';

type ActiveTab = 'history' | 'champions' | 'all-champions' | 'mastery' | 'insights' | 'items';

export interface CoachTip {
  severity: 'critical' | 'warning' | 'info' | 'good';
  category: string;
  icon: string;
  title: string;
  message: string;
  stat: string;
  action: string;
}

interface HourSlot  { label: string; games: number; wins: number; wr: number; }
interface DaySlot   { label: string; games: number; wins: number; wr: number; }
interface SessionPos { pos: string; games: number; wins: number; wr: number; }
interface WeekPoint  { label: string; games: number; wins: number; wr: number; }
interface GlobalTrend {
  hourSlots:   HourSlot[];
  daySlots:    DaySlot[];
  sessionPos:  SessionPos[];
  weekPoints:  WeekPoint[];
  streakWin:   number;
  streakLoss:  number;
  last10Wr:    number;
  allWr:       number;
  bestHour:    string;
  worstHour:   string;
  bestDay:     string;
  worstDay:    string;
  tiltRisk:    boolean;
}

// v4: filter matches < 15 min (bumped from v3 which added queue=420 filter)
const CACHE_VERSION = 4;

function cacheKey(puuid: string): string { return `lol_cache_${puuid}`; }

function slimMatch(m: Match): Match {
  return {
    metadata: { matchId: m.metadata.matchId },
    info: {
      gameDuration: m.info.gameDuration,
      gameCreation:  m.info.gameCreation,
      gameMode:      m.info.gameMode,
      queueId:       m.info.queueId ?? 0,
      participants:  m.info.participants.map(p => ({
        puuid:                       p.puuid,
        summonerName:                p.summonerName   || '',
        riotIdGameName:              p.riotIdGameName || '',
        championName:                p.championName,
        teamId:                      p.teamId,
        teamPosition:                p.teamPosition   || '',
        kills:   p.kills,  deaths: p.deaths, assists: p.assists, win: p.win,
        totalMinionsKilled:          p.totalMinionsKilled          || 0,
        neutralMinionsKilled:        p.neutralMinionsKilled        || 0,
        goldEarned:                  p.goldEarned                  || 0,
        visionScore:                 p.visionScore                 || 0,
        totalDamageDealtToChampions: p.totalDamageDealtToChampions || 0,
        item0: p.item0||0, item1: p.item1||0, item2: p.item2||0,
        item3: p.item3||0, item4: p.item4||0, item5: p.item5||0, item6: p.item6||0,
        summoner1Id: p.summoner1Id || 0,
        summoner2Id: p.summoner2Id || 0,
        perks: p.perks ?? null,
      }))
    }
  } as Match;
}

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, ProfileCard, RankedStats, MatchHistory, ChampionMastery, ChampionDetail],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnDestroy {
  showSplash    = true;
  splashLeaving = false;

  searchName = 'Derrick rose';
  searchTag  = 'MONO';

  profile:       SummonerProfile | null = null;
  matches:       Match[]  = [];
  loading        = false;
  loadingMatches = false;
  error          = '';
  puuid          = '';

  seasonTotal: number | null = null;
  seasonDone  = false;

  fromCache   = false;
  cacheAge    = '';

  activeTab: ActiveTab = 'history';

  globalTrend: GlobalTrend | null = null;

  coachTips: CoachTip[] = [];
  coachExpanded: { [i: number]: boolean } = {};

  itemAnalChamp  = '';
  itemAnalItemId = 0;
  itemAnalResult: any = null;
  itemAnalLoading = false;
  itemAnalError   = '';

  getPlayerItems(): { id: number; name: string; count: number }[] {
    const map = new Map<number, number>();
    for (const m of this.matches) {
      const p = m.info.participants.find(x => x.puuid === this.puuid);
      if (!p) continue;
      for (const id of [p.item0,p.item1,p.item2,p.item3,p.item4,p.item5]) {
        if (id && this.riotApi.isCompleteItem(id)) map.set(id, (map.get(id) ?? 0) + 1);
      }
    }
    return [...map.entries()]
      .map(([id, count]) => ({ id, count, name: this.riotApi.getItemDetail(id)?.name ?? `Item ${id}` }))
      .sort((a, b) => b.count - a.count);
  }

  getChampNamesPlayed(): string[] {
    const s = new Set<string>();
    for (const m of this.matches) {
      const p = m.info.participants.find(x => x.puuid === this.puuid);
      if (p) s.add(p.championName);
    }
    return [...s].sort();
  }

  runItemAnalysis(): void {
    if (!this.itemAnalChamp || !this.itemAnalItemId || !this.puuid) return;
    this.itemAnalLoading = true;
    this.itemAnalResult  = null;
    this.itemAnalError   = '';
    this.riotApi.getItemMatchup(this.puuid, this.itemAnalChamp, this.itemAnalItemId).subscribe({
      next: (data) => {
        this.itemAnalResult  = data;
        this.itemAnalLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.itemAnalError   = 'Error al calcular';
        this.itemAnalLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  laneFilter  = '';
  queueFilter = '';

  sortCol: 'games' | 'wr' | 'kda' | 'cs' | 'dmg' = 'games';
  sortDir: 'asc' | 'desc' = 'desc';

  masterySortCol: 'level' | 'points' | 'name' = 'points';
  masterySortDir: 'asc' | 'desc' = 'desc';

  masteryModal: MasteryEntry | null = null;
  openMasteryModal(m: MasteryEntry) { this.masteryModal = m; this.cdr.detectChanges(); }
  closeMasteryModal() { this.masteryModal = null; this.cdr.detectChanges(); }

  private seasonEs: EventSource | null = null;

  perksUpdating   = false;
  perksDone       = 0;
  perksTotal      = 0;
  perksProgress   = 0;
  get matchesWithoutPerks(): number {
    return this.matches.filter(m =>
      !m.info.participants.find(p => p.puuid === this.puuid)?.perks
    ).length;
  }

  readonly RANK_AVG: Record<string, { cs: number; dmg: number; kda: number; vision: number }> = {
    iron:        { cs: 3.8,  dmg: 10_500, kda: 1.8, vision: 0.75 },
    bronze:      { cs: 5.1,  dmg: 14_500, kda: 2.0, vision: 0.85 },
    silver:      { cs: 6.3,  dmg: 18_000, kda: 2.2, vision: 0.95 },
    gold:        { cs: 7.1,  dmg: 21_000, kda: 2.4, vision: 1.05 },
    platinum:    { cs: 7.7,  dmg: 23_500, kda: 2.6, vision: 1.10 },
    emerald:     { cs: 8.0,  dmg: 25_000, kda: 2.8, vision: 1.15 },
    diamond:     { cs: 8.3,  dmg: 27_500, kda: 3.0, vision: 1.25 },
    master:      { cs: 8.7,  dmg: 30_000, kda: 3.3, vision: 1.35 },
    grandmaster: { cs: 9.0,  dmg: 32_000, kda: 3.5, vision: 1.45 },
    challenger:  { cs: 9.4,  dmg: 35_000, kda: 3.8, vision: 1.60 },
  };

  constructor(public riotApi: RiotApiService, private cdr: ChangeDetectorRef) {}

  startUpdatePerks(): void {
    if (!this.puuid || this.perksUpdating) return;
    this.perksUpdating = true;
    this.perksDone     = 0;
    this.perksTotal    = 0;
    this.perksProgress = 0;

    this.riotApi.triggerUpdatePerks(this.puuid).subscribe({
      next: (ev: any) => {
        if (ev.type === 'total')    { this.perksTotal = ev.count; }
        if (ev.type === 'progress') {
          this.perksDone     = ev.done;
          this.perksTotal    = ev.total;
          this.perksProgress = Math.round((ev.done / ev.total) * 100);
        }
        this.cdr.detectChanges();
      },
      complete: () => {
        this.perksUpdating = false;
        this.perksProgress = 100;
        localStorage.removeItem(`lol_cache_${this.puuid}`);
        this.cdr.detectChanges();
      },
      error: () => { this.perksUpdating = false; this.cdr.detectChanges(); }
    });
  }

  ngOnDestroy() { this.seasonEs?.close(); }

  enterApp() {
    this.splashLeaving = true;
    this.cdr.detectChanges();
    setTimeout(() => { this.showSplash = false; this.cdr.detectChanges(); }, 600);
  }

  setTab(tab: ActiveTab) {
    this.activeTab = tab;
    this.cdr.detectChanges();
  }

  setLane(lane: string)  { this.laneFilter  = lane; this.cdr.detectChanges(); }
  setQueue(q:   string)  { this.queueFilter = q;    this.cdr.detectChanges(); }

  setSort(col: 'games' | 'wr' | 'kda' | 'cs' | 'dmg') {
    this.sortDir = this.sortCol === col && this.sortDir === 'desc' ? 'asc' : 'desc';
    this.sortCol = col;
    this.cdr.detectChanges();
  }

  setMasterySort(col: 'level' | 'points' | 'name') {
    this.masterySortDir = this.masterySortCol === col && this.masterySortDir === 'desc' ? 'asc' : 'desc';
    this.masterySortCol = col;
    this.cdr.detectChanges();
  }

  getMasterySorted(): MasteryEntry[] {
    const list = [...(this.profile?.mastery ?? [])];
    list.sort((a, b) => {
      let diff = 0;
      if (this.masterySortCol === 'level')  diff = b.championLevel - a.championLevel || b.championPoints - a.championPoints;
      if (this.masterySortCol === 'points') diff = b.championPoints - a.championPoints;
      if (this.masterySortCol === 'name')   diff = (a.championName ?? '').localeCompare(b.championName ?? '');
      return this.masterySortDir === 'asc' ? -diff : diff;
    });
    return list;
  }

  masteryPct(m: MasteryEntry): number {
    const s = m.championPointsSinceLastLevel ?? 0;
    const u = m.championPointsUntilNextLevel ?? 0;
    if (s === 0 && u === 0) return 100;
    return Math.round((s / (s + u)) * 100);
  }

  masteryNextLabel(m: MasteryEntry): string {
    const u = m.championPointsUntilNextLevel;
    if (!u || u === 0) return 'Nivel máx.';
    const pts = u >= 1000 ? (u / 1000).toFixed(1) + 'k' : `${u}`;
    return `${pts} pts → nv.${m.championLevel + 1}`;
  }

  masteryLevelColor(level: number): string {
    if (level >= 21) return '#f4c874';
    if (level >= 15) return '#c8aa6e';
    if (level >= 10) return '#e84848';
    if (level >= 7)  return '#9d48e8';
    if (level >= 5)  return '#57bf5e';
    return '#5a6a7a';
  }

  formatMasteryPts(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(0) + 'K';
    return `${n}`;
  }

  private getFilteredMatches(): Match[] {
    return this.matches.filter(m => {
      if (this.queueFilter && (m.info.queueId ?? 0).toString() !== this.queueFilter) return false;
      if (this.laneFilter) {
        const p = m.info.participants.find(x => x.puuid === this.puuid);
        return p?.teamPosition === this.laneFilter;
      }
      return true;
    });
  }

  filteredMatchCount(): number { return this.getFilteredMatches().length; }

  search() {
    if (!this.searchName.trim() || !this.searchTag.trim()) return;

    this.seasonEs?.close();
    this.loading        = true;
    this.loadingMatches = false;
    this.error          = '';
    this.profile        = null;
    this.matches        = [];
    this.puuid          = '';
    this.seasonTotal    = null;
    this.seasonDone     = false;
    this.fromCache      = false;
    this.cacheAge       = '';
    this.activeTab      = 'history';
    this.cdr.detectChanges();

    this.riotApi.getSummoner(this.searchName.trim(), this.searchTag.trim()).subscribe({
      next: (data) => {
        this.profile = data;
        this.puuid   = data.account.puuid;
        this.riotApi.setDdVersion(data.ddVersion);
        this.loading = false;
        this.cdr.detectChanges();
        this.fetchAllSeasonMatches();
      },
      error: (err) => {
        this.error   = err.error?.error || 'No se pudo conectar con la API';
        this.loading = false;
        this.cdr.detectChanges();
      }
    });
  }

  private saveToCache(puuid: string, matches: Match[]): void {
    try {
      const payload = JSON.stringify({ v: CACHE_VERSION, ts: Date.now(), matches: matches.map(slimMatch) });
      localStorage.setItem(cacheKey(puuid), payload);
    } catch { /* QuotaExceededError */ }
  }

  private loadFromCache(puuid: string): Match[] | null {
    try {
      const raw = localStorage.getItem(cacheKey(puuid));
      if (!raw) return null;
      const { v, ts, matches } = JSON.parse(raw) as { v?: number; ts: number; matches: Match[] };
      if ((v ?? 1) < CACHE_VERSION) {
        localStorage.removeItem(cacheKey(puuid));
        return null;
      }
      const ageMin  = Math.floor((Date.now() - ts) / 60_000);
      const ageHour = Math.floor(ageMin / 60);
      const ageDays = Math.floor(ageHour / 24);
      this.cacheAge = ageDays >= 1
        ? `hace ${ageDays}d`
        : ageHour >= 1
          ? `hace ${ageHour}h`
          : `hace ${ageMin} min`;
      return matches;
    } catch { return null; }
  }

  clearCacheAndSearch(): void {
    if (!this.puuid) return;
    this.seasonEs?.close();

    const afterId  = this.matches.length > 0 ? this.matches[0].metadata.matchId : null;
    const existing = [...this.matches];

    this.fromCache = false;
    this.cacheAge  = '';
    this.streamSeasonMatches(afterId, existing);
  }

  private fetchAllSeasonMatches(): void {
    this.loadingMatches = true;
    this.matches        = [];
    this.seasonTotal    = null;
    this.seasonDone     = false;
    this.fromCache      = false;
    this.cdr.detectChanges();

    const cached = this.loadFromCache(this.puuid);
    if (cached) {
      this.matches        = cached;
      this.loadingMatches = false;
      this.seasonDone     = true;
      this.fromCache      = true;
      this.computeGlobalTrend();
      this.cdr.detectChanges();
      return;
    }

    this.streamSeasonMatches(null, []);
  }

  private streamSeasonMatches(afterId: string | null, existing: Match[]): void {
    this.loadingMatches = true;
    this.seasonTotal    = null;
    this.seasonDone     = false;
    this.cdr.detectChanges();

    const url = afterId
      ? `http://localhost:3000/api/matches/${this.puuid}/season?afterId=${encodeURIComponent(afterId)}`
      : `http://localhost:3000/api/matches/${this.puuid}/season`;

    const newBatch: Match[] = [];
    const es = new EventSource(url);
    this.seasonEs = es;

    es.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.type === 'total') {
        this.seasonTotal = data.count;
      } else if (data.type === 'match') {
        newBatch.push(data.match);
        this.matches = [...newBatch, ...existing];
      }
      this.cdr.detectChanges();
    };

    es.addEventListener('done', () => {
      es.close();
      this.seasonEs       = null;
      this.loadingMatches = false;
      this.seasonDone     = true;
      if (newBatch.length === 0) this.matches = existing;
      this.saveToCache(this.puuid, this.matches);
      this.computeGlobalTrend();
      this.cdr.detectChanges();
    });

    es.addEventListener('error', (e: Event) => {
      const msg = (e as any).data
        ? JSON.parse((e as any).data).error
        : 'Error cargando partidas';
      if (this.matches.length === 0) this.error = msg;
      es.close();
      this.seasonEs       = null;
      this.loadingMatches = false;
      this.cdr.detectChanges();
    });

    es.onerror = () => {
      if (!this.seasonDone) {
        es.close();
        this.seasonEs       = null;
        this.loadingMatches = false;
        this.cdr.detectChanges();
      }
    };
  }

  getChampionStats(): ChampionStat[] {
    const map = new Map<string, ChampionStat>();
    for (const match of this.getFilteredMatches()) {
      const p = match.info.participants.find(x => x.puuid === this.puuid);
      if (!p) continue;
      const key = p.championName;
      if (!map.has(key)) map.set(key, {
        championName: key, games: 0, wins: 0,
        kills: 0, deaths: 0, assists: 0,
        totalCs: 0, totalDuration: 0, totalDmg: 0
      });
      const s = map.get(key)!;
      s.games++;
      if (p.win) s.wins++;
      s.kills   += p.kills;
      s.deaths  += p.deaths;
      s.assists += p.assists;
      s.totalCs += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
      s.totalDuration += match.info.gameDuration;
      s.totalDmg += p.totalDamageDealtToChampions || 0;
    }
    const stats = [...map.values()];
    stats.sort((a, b) => {
      let diff = 0;
      switch (this.sortCol) {
        case 'games': diff = b.games - a.games; break;
        case 'wr':    diff = this.csWinrate(b) - this.csWinrate(a); break;
        case 'kda':   diff = parseFloat(this.csKda(b)) - parseFloat(this.csKda(a)); break;
        case 'cs':    diff = parseFloat(this.csPerMin(b)) - parseFloat(this.csPerMin(a)); break;
        case 'dmg':   diff = (b.totalDmg / b.games) - (a.totalDmg / a.games); break;
      }
      if (diff === 0) diff = b.games - a.games;
      return this.sortDir === 'asc' ? -diff : diff;
    });
    return stats;
  }

  computeGlobalTrend(): void {
    const ms = this.matches.filter(m => m.info.queueId === 420);
    if (ms.length < 5) { this.globalTrend = null; return; }

    const sorted = [...ms].sort((a, b) => a.info.gameCreation - b.info.gameCreation);
    const me = (m: Match) => m.info.participants.find(p => p.puuid === this.puuid);

    const HOUR_BRACKETS = [
      { label: '00–05',  h: [0,1,2,3,4] },
      { label: '06–09',  h: [6,7,8,9] },
      { label: '10–13',  h: [10,11,12,13] },
      { label: '14–17',  h: [14,15,16,17] },
      { label: '18–21',  h: [18,19,20,21] },
      { label: '22–23',  h: [22,23] },
    ];
    const hourMap = new Map<string, { games: number; wins: number }>();
    for (const b of HOUR_BRACKETS) hourMap.set(b.label, { games: 0, wins: 0 });
    for (const m of sorted) {
      const p = me(m); if (!p) continue;
      const h = new Date(m.info.gameCreation).getHours();
      const bracket = HOUR_BRACKETS.find(b => b.h.includes(h));
      if (!bracket) continue;
      const e = hourMap.get(bracket.label)!;
      e.games++; if (p.win) e.wins++;
    }
    const hourSlots: HourSlot[] = [...hourMap.entries()]
      .map(([label, { games, wins }]) => ({
        label, games, wins,
        wr: games > 0 ? Math.round((wins / games) * 100) : 0,
      }))
      .filter(s => s.games > 0);

    const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
    const dayMap = new Map<number, { games: number; wins: number }>();
    for (let i = 0; i < 7; i++) dayMap.set(i, { games: 0, wins: 0 });
    for (const m of sorted) {
      const p = me(m); if (!p) continue;
      const d = new Date(m.info.gameCreation).getDay();
      const e = dayMap.get(d)!;
      e.games++; if (p.win) e.wins++;
    }
    const daySlots: DaySlot[] = [...dayMap.entries()]
      .map(([d, { games, wins }]) => ({
        label: DAY_LABELS[d], games, wins,
        wr: games > 0 ? Math.round((wins / games) * 100) : 0,
      }))
      .filter(s => s.games > 0);

    // New session if more than 2 hours have passed since the last game
    const SESSION_GAP = 2 * 60 * 60 * 1000;
    const posMap = new Map<string, { games: number; wins: number }>();
    const posLabels: Record<number, string> = { 1: '1ª partida', 2: '2ª partida', 3: '3ª partida', 4: '4ª+' };
    for (const k of Object.values(posLabels)) posMap.set(k, { games: 0, wins: 0 });
    let sessionPos = 1;
    for (let i = 0; i < sorted.length; i++) {
      const p = me(sorted[i]); if (!p) continue;
      if (i > 0) {
        const gap = sorted[i].info.gameCreation - sorted[i-1].info.gameCreation;
        sessionPos = gap > SESSION_GAP ? 1 : sessionPos + 1;
      }
      const posKey = posLabels[Math.min(sessionPos, 4)];
      const e = posMap.get(posKey)!;
      e.games++; if (p.win) e.wins++;
    }
    const sessionPosArr: SessionPos[] = [...posMap.entries()]
      .map(([pos, { games, wins }]) => ({
        pos, games, wins,
        wr: games > 0 ? Math.round((wins / games) * 100) : 0,
      }))
      .filter(s => s.games > 0);

    const weekMap = new Map<string, { games: number; wins: number }>();
    for (const m of sorted) {
      const p = me(m); if (!p) continue;
      const d = new Date(m.info.gameCreation);
      const jan1 = new Date(d.getFullYear(), 0, 1);
      const wk = Math.ceil(((d.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7);
      const key = `${d.getFullYear()}-S${wk.toString().padStart(2,'0')}`;
      if (!weekMap.has(key)) weekMap.set(key, { games: 0, wins: 0 });
      const e = weekMap.get(key)!;
      e.games++; if (p.win) e.wins++;
    }
    const weekPoints: WeekPoint[] = [...weekMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-12)
      .map(([label, { games, wins }]) => ({
        label: label.replace(/^\d{4}-/, ''),
        games, wins,
        wr: games > 0 ? Math.round((wins / games) * 100) : 0,
      }));

    const chronoDesc = [...sorted].reverse();
    let streakWin = 0, streakLoss = 0;
    for (const m of chronoDesc) {
      const p = me(m); if (!p) break;
      if (p.win) { if (streakLoss > 0) break; streakWin++; }
      else        { if (streakWin  > 0) break; streakLoss++; }
    }

    const last10 = chronoDesc.slice(0, 10);
    const last10Wins = last10.filter(m => me(m)?.win).length;
    const last10Wr   = Math.round((last10Wins / last10.length) * 100);
    const allWr      = Math.round((ms.filter(m => me(m)?.win).length / ms.length) * 100);

    const validH = hourSlots.filter(s => s.games >= 3);
    const bestHour  = validH.sort((a, b) => b.wr - a.wr)[0]?.label ?? '—';
    const worstHour = [...validH].sort((a, b) => a.wr - b.wr)[0]?.label ?? '—';
    const validD = daySlots.filter(s => s.games >= 3);
    const bestDay   = validD.sort((a, b) => b.wr - a.wr)[0]?.label ?? '—';
    const worstDay  = [...validD].sort((a, b) => a.wr - b.wr)[0]?.label ?? '—';

    const wr1 = sessionPosArr.find(s => s.pos === '1ª partida')?.wr ?? 50;
    const wr3 = sessionPosArr.find(s => s.pos === '3ª partida')?.wr ?? 50;
    const wr4 = sessionPosArr.find(s => s.pos === '4ª+')?.wr ?? 50;
    const tiltRisk = (wr1 - Math.min(wr3, wr4)) >= 15;

    this.globalTrend = {
      hourSlots, daySlots, sessionPos: sessionPosArr, weekPoints,
      streakWin, streakLoss, last10Wr, allWr,
      bestHour, worstHour, bestDay, worstDay, tiltRisk,
    };
    this.computeCoachTips();
    this.cdr.detectChanges();
  }

  computeCoachTips(): void {
    const ms = this.matches.filter(m => m.info.queueId === 420 || m.info.queueId === 0);
    if (ms.length < 5) { this.coachTips = []; return; }

    const meOf = (m: Match) => m.info.participants.find(p => p.puuid === this.puuid);
    const solo  = this.profile?.ranked?.find(r => r.queueType === 'RANKED_SOLO_5x5');
    const tier  = solo?.tier?.toLowerCase() || 'silver';
    const avg   = this.RANK_AVG[tier] ?? this.RANK_AVG['silver'];

    let totalCs = 0, totalDur = 0, totalDeaths = 0, totalVision = 0, totalDmg = 0;
    let wins = 0, totalDeathsWin = 0, totalDeathsLoss = 0, winsN = 0, lossN = 0;
    let gamesDeaths5 = 0, winsDeaths5 = 0;
    const champMap = new Map<string, { games: number; wins: number }>();
    const sorted = [...ms].sort((a, b) => a.info.gameCreation - b.info.gameCreation);

    for (const m of sorted) {
      const p = meOf(m); if (!p) continue;
      const dur = m.info.gameDuration;
      const cs  = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
      totalCs      += cs;
      totalDur     += dur;
      totalDeaths  += p.deaths;
      totalVision  += p.visionScore || 0;
      totalDmg     += p.totalDamageDealtToChampions || 0;
      if (p.win) { wins++; winsN++; totalDeathsWin  += p.deaths; }
      else        {         lossN++; totalDeathsLoss += p.deaths; }
      if (p.deaths >= 5) { gamesDeaths5++; if (p.win) winsDeaths5++; }
      if (!champMap.has(p.championName)) champMap.set(p.championName, { games: 0, wins: 0 });
      const cs2 = champMap.get(p.championName)!;
      cs2.games++; if (p.win) cs2.wins++;
    }

    const games      = ms.length;
    const avgCsMin   = totalDur > 0 ? (totalCs / totalDur) * 60 : 0;
    const avgDeaths  = totalDeaths / games;
    const avgVisMin  = totalDur > 0 ? (totalVision / totalDur) * 60 : 0;
    const allWr      = Math.round((wins / games) * 100);
    const avgDmg     = totalDmg / games;

    const tips: CoachTip[] = [];
    const ORDER = { critical: 0, warning: 1, info: 2, good: 3 };

    const csDiff = avg.cs - avgCsMin;
    if (csDiff > 0.4) {
      const goldLost = Math.round(csDiff * 21 * 18);
      tips.push({
        severity: csDiff > 1.5 ? 'critical' : 'warning',
        category: 'cs', icon: '🌾',
        title: 'CS/min por debajo del objetivo',
        message: `Tu media de ${avgCsMin.toFixed(1)} cs/min está ${csDiff.toFixed(1)} por debajo del objetivo ${tier} (${avg.cs}/m). Son ~${Math.round(goldLost / 1000)}k de oro perdido por partida.`,
        stat: `${avgCsMin.toFixed(1)} / ${avg.cs}/m`,
        action: `Practica 10 min de farmeo en Training Mode antes de cada sesión. Objetivo: nunca bajar de ${(avg.cs - 0.3).toFixed(1)}/m.`,
      });
    }

    if (avgDeaths > 4.5) {
      const wr5 = gamesDeaths5 > 0 ? Math.round(winsDeaths5 / gamesDeaths5 * 100) : 0;
      tips.push({
        severity: avgDeaths > 6.5 ? 'critical' : 'warning',
        category: 'deaths', icon: '💀',
        title: 'Demasiadas muertes por partida',
        message: `Media de ${avgDeaths.toFixed(1)} muertes/partida. En partidas con ≥5 muertes tu WR cae al ${wr5}% (vs ${allWr}% global). Cada muerte regala ~${Math.round(300 + avgDeaths * 15)}g al rival.`,
        stat: `${avgDeaths.toFixed(1)} muertes/p`,
        action: 'Cuando ya hayas muerto 2 veces antes del min 15, recuerda: "Prioritize staying alive over kills".',
      });
    }

    const visDiff = avg.vision - avgVisMin;
    if (visDiff > 0.15) {
      tips.push({
        severity: 'warning',
        category: 'vision', icon: '👁️',
        title: 'Control de visión mejorable',
        message: `${avgVisMin.toFixed(2)} visión/min vs ${avg.vision.toFixed(2)}/min de referencia ${tier}. La visión reduce ganks y te permite tomar objetivos con seguridad.`,
        stat: `${avgVisMin.toFixed(2)} / ${avg.vision.toFixed(2)}/m`,
        action: 'Compra un ward de control cada vuelta de base. Coloca wards en el río/jungla enemiga antes de farmear.',
      });
    }

    const dmgDiff = avg.dmg - avgDmg;
    if (dmgDiff > 3000) {
      tips.push({
        severity: 'info',
        category: 'damage', icon: '⚔️',
        title: 'Daño a campeones bajo',
        message: `${Math.round(avgDmg / 1000)}k daño/partida vs ${Math.round(avg.dmg / 1000)}k de referencia ${tier}. Puedes estar demasiado centrado en farmar y poco en participar en peleas.`,
        stat: `${Math.round(avgDmg / 1000)}k / ${Math.round(avg.dmg / 1000)}k ref`,
        action: 'Busca activamente peleas post-6 y teamfights. Compra items ofensivos antes que los de utilidad.',
      });
    }

    const bestChamp = [...champMap.entries()]
      .filter(([, v]) => v.games >= 3)
      .map(([name, v]) => ({ name, games: v.games, wr: Math.round(v.wins / v.games * 100) }))
      .filter(c => c.wr >= 60).sort((a, b) => b.wr - a.wr)[0];
    const mostPlayed = [...champMap.entries()].sort((a, b) => b[1].games - a[1].games)[0];
    if (bestChamp && mostPlayed && bestChamp.name !== mostPlayed[0] && bestChamp.games < games * 0.2) {
      tips.push({
        severity: 'info',
        category: 'champion', icon: '🏆',
        title: `Juega más a ${bestChamp.name}`,
        message: `${bestChamp.name}: ${bestChamp.wr}% WR en ${bestChamp.games} partidas (solo ${Math.round(bestChamp.games / games * 100)}% de tus juegos). ${mostPlayed[0]} es tu más jugado pero quizá no el más efectivo.`,
        stat: `${bestChamp.wr}% WR · ${bestChamp.games}p`,
        action: `Prueba ${bestChamp.name} durante 10 partidas seguidas. La especialización acelera el subida de elo.`,
      });
    }

    if (this.globalTrend?.tiltRisk) {
      const wr1 = this.globalTrend.sessionPos.find(s => s.pos === '1ª partida')?.wr ?? 50;
      const wr3 = Math.min(
        this.globalTrend.sessionPos.find(s => s.pos === '3ª partida')?.wr ?? wr1,
        this.globalTrend.sessionPos.find(s => s.pos === '4ª+')?.wr ?? wr1
      );
      tips.push({
        severity: 'critical',
        category: 'tilt', icon: '🧠',
        title: 'Riesgo de tilt detectado',
        message: `Tu WR en la 1ª partida de sesión es ${wr1}%, pero cae a ${wr3}% en la 3ª o más. Tu rendimiento se deteriora significativamente en sesiones largas.`,
        stat: `${wr1}% → ${wr3}% (3ª+ p)`,
        action: 'Regla de las 2 partidas: para, come algo y estira antes de continuar. Nunca juegues frustrado.',
      });
    }

    if (winsN >= 3 && lossN >= 3) {
      const avgDW = totalDeathsWin  / winsN;
      const avgDL = totalDeathsLoss / lossN;
      if (avgDL - avgDW >= 2.0) {
        tips.push({
          severity: 'info',
          category: 'deaths', icon: '📊',
          title: 'Muertes aumentan mucho en derrota',
          message: `Ganas con ${avgDW.toFixed(1)} muertes/p, pierdes con ${avgDL.toFixed(1)} (+${(avgDL - avgDW).toFixed(1)}). Cuando el rival va adelante, tu cometido es sobrevivir, no "catch up" con kills.`,
          stat: `+${(avgDL - avgDW).toFixed(1)} muertes en D`,
          action: 'Si pierdes las primeras peleas, construye items defensivos y busca teamfights con tu equipo, no 1v1s.',
        });
      }
    }

    if (allWr >= 54 && games >= 20) {
      tips.push({
        severity: 'good',
        category: 'climbing', icon: '🚀',
        title: '¡Subiendo elo con consistencia!',
        message: `Con ${allWr}% WR en ${games} partidas estás por encima del 50% mínimo. Con esta tasa subirías ~${Math.round((allWr - 50) * 0.4)} LP netos por cada 10 partidas.`,
        stat: `${allWr}% WR · ${games} partidas`,
        action: 'Mantén el mismo enfoque. Cuando una sesión vaya mal, para: el elo que tienes no desaparece.',
      });
    }

    this.coachTips = tips.sort((a, b) => ORDER[a.severity] - ORDER[b.severity]).slice(0, 7);
    this.cdr.detectChanges();
  }

  getRankAvg(): { cs: number; dmg: number } {
    const solo = this.profile?.ranked?.find(r => r.queueType === 'RANKED_SOLO_5x5');
    const tier = solo?.tier?.toLowerCase() || 'silver';
    return this.RANK_AVG[tier] ?? this.RANK_AVG['silver'];
  }

  getRankLabel(): string {
    const solo = this.profile?.ranked?.find(r => r.queueType === 'RANKED_SOLO_5x5');
    if (!solo) return 'Plata';
    return solo.tier.charAt(0) + solo.tier.slice(1).toLowerCase();
  }

  csWinrate(s: ChampionStat): number { return Math.round((s.wins / s.games) * 100); }

  csKda(s: ChampionStat): string {
    const d = (s.deaths / s.games) || 1;
    return (((s.kills + s.assists) / s.games) / d).toFixed(2);
  }

  csAvgKills(s: ChampionStat):   string { return (s.kills   / s.games).toFixed(1); }
  csAvgDeaths(s: ChampionStat):  string { return (s.deaths  / s.games).toFixed(1); }
  csAvgAssists(s: ChampionStat): string { return (s.assists / s.games).toFixed(1); }

  csPerMin(s: ChampionStat): string {
    const min = s.totalDuration / 60;
    return min > 0 ? (s.totalCs / min).toFixed(1) : '0.0';
  }

  csDiff(s: ChampionStat): string {
    const diff = parseFloat(this.csPerMin(s)) - this.getRankAvg().cs;
    return (diff >= 0 ? '+' : '') + diff.toFixed(1);
  }

  csDiffGood(s: ChampionStat): boolean { return parseFloat(this.csDiff(s)) > 0; }

  csAvgDmg(s: ChampionStat): string {
    return Math.round(s.totalDmg / s.games).toLocaleString('es-ES');
  }

  dmgDiff(s: ChampionStat): string {
    const diff = Math.round(s.totalDmg / s.games) - this.getRankAvg().dmg;
    return (diff >= 0 ? '+' : '') + Math.round(diff / 1000) + 'k';
  }

  dmgDiffGood(s: ChampionStat): boolean {
    return (s.totalDmg / s.games) > this.getRankAvg().dmg;
  }
}
