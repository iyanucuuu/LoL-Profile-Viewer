import { Component, Input, OnChanges, SimpleChanges, OnDestroy, ChangeDetectorRef, HostListener } from '@angular/core';
import { CommonModule }   from '@angular/common';
import { FormsModule }    from '@angular/forms';
import { DomSanitizer, SafeStyle } from '@angular/platform-browser';
import { Subscription, from, timer, of } from 'rxjs';
import { concatMap, switchMap, catchError, take } from 'rxjs/operators';
import { Match, Participant, ItemEvent, RiotApiService } from '../../services/riot-api';

export interface ChampionListEntry {
  championName:  string;
  games:         number;
  wins:          number;
  kills:         number;
  deaths:        number;
  assists:       number;
  totalCs:       number;
  totalDuration: number;
  totalDmg:      number;
}

export interface ItemUsage   { id: number; count: number; pct: number; wr: number; }
export interface SpellCombo  { s1: number; s2: number; count: number; pct: number; wins: number; wr: number; }
export interface RuneStat    { id: number; count: number; wins: number; pct: number; wr: number; }
export interface RuneSlotStat { runes: RuneStat[] }
export interface RunePathStat {
  pathId:  number;
  count:   number;
  pct:     number;
  wr:      number;
  slots:   RuneSlotStat[];
}

export interface MatchupEntry {
  championName: string;
  games: number; wins: number;
  wr: number; delta: number;
}

export interface PerGameStat {
  cs:       number;
  deaths:   number;
  won:      boolean;
  date:     number;
  csX:      number;
  csY:      number;
  deathPct: number;
  csPct:    number;
  csGood:   boolean;
}

export interface TrendPeriod {
  label:   string;
  games:   number;
  wins:    number;
  wr:      number;
  avgKda:  number;
  avgCs:   number;
}

export interface ChampionDetailData {
  championName:  string;
  games:         number;
  wins:          number;
  wr:            number;
  avgKills:      number;
  avgDeaths:     number;
  avgAssists:    number;
  csPerMin:      number;
  avgDmg:        number;
  avgKp:         number;
  avgVision:     number;
  topPosition:   string;
  topBoots:      ItemUsage[];
  topSpells:     SpellCombo[];
  goodMatchups:  MatchupEntry[];
  badMatchups:   MatchupEntry[];
  perGame:       PerGameStat[];
  csChartLine:   string;
  csRefY:        number | null;
  csMinVal:      number;
  csMaxVal:      number;
  csAvgVal:      number;
  deathsMax:     number;
  deathsAvg:     number;
  trendPeriods:  TrendPeriod[];
  avgGameMin:    number;
  avgGameMinWin: number;
  avgGameMinLoss:number;
}

const BOOT_IDS = new Set<number>([
  3006, 3009, 3020, 3047, 3111, 3117, 3158,
]);

const COMPONENT_IDS = new Set<number>([
  1036, 1037, 1038, 1042, 1043,
  1004, 1006, 1011, 1018, 1026, 1027, 1028, 1029, 1033, 1052, 1057, 1058,
  1054, 1055, 1056, 1082, 1083, 2051,
  1035, 1039, 1041,
  1053,
  2003, 2010, 2031, 2033, 2055,
  2419, 2420,
  3340, 3341, 3363, 3364,
  3035, 3051, 3066, 3086, 3133, 3134,
  3870,
  3076, 3082, 3105,
  3108, 3114, 3145, 3155,
  3211,
]);

const CW = 500, CH = 70, CPAD = 8;

const POS_LABEL: Record<string, string> = {
  TOP: 'Top', JUNGLE: 'Jg', MIDDLE: 'Mid', BOTTOM: 'ADC', UTILITY: 'Sup'
};

@Component({
  selector: 'app-champion-detail',
  imports: [CommonModule, FormsModule],
  templateUrl: './champion-detail.html',
  styleUrl: './champion-detail.css'
})
export class ChampionDetail implements OnChanges, OnDestroy {
  @Input() matches:  Match[]                     = [];
  @Input() puuid     = '';
  @Input() rankAvg:  { cs: number; dmg: number; kda?: number; vision?: number } = { cs: 6.3, dmg: 18_000, kda: 2.5, vision: 1.1 };

  selected:  string | null             = null;
  champList: ChampionListEntry[]       = [];
  detail:    ChampionDetailData | null = null;

  inventoryItems: ItemUsage[] = [];
  matchupOpponent: string | null = null;

  primaryRunePaths:   RunePathStat[]  = [];
  secondaryRuneStats: RuneStat[][]    = [];
  statShardStats:     RuneStat[][]    = [];
  runeGamesTotal      = 0;

  opponentFilter  = '';
  opponents: string[] = [];
  oppDropdownOpen = false;

  private champBuildCache    = new Map<string, { items: ItemUsage[][]; boot: ItemUsage[] }>();
  private champInventoryCache = new Map<string, ItemUsage[]>();

  itemAnalItemId  = 0;
  itemAnalResult: any = null;
  itemAnalLoading = false;
  itemAnalError   = '';

  getChampItems(): { id: number; name: string; count: number }[] {
    if (!this.selected || !this.puuid) return [];
    const map = new Map<number, number>();
    for (const m of this.matches) {
      const p = m.info.participants.find(x => x.puuid === this.puuid);
      if (!p || p.championName !== this.selected) continue;
      for (const id of [p.item0,p.item1,p.item2,p.item3,p.item4,p.item5]) {
        if (id && this.riotApi.isCompleteItem(id)) map.set(id, (map.get(id) ?? 0) + 1);
      }
    }
    return [...map.entries()]
      .map(([id, count]) => ({ id, count, name: this.riotApi.getItemDetail(id)?.name ?? `${id}` }))
      .sort((a, b) => b.count - a.count);
  }

  selectItemForAnalysis(id: number): void {
    this.itemAnalItemId = id;
    this.runItemAnalysis();
  }

  runItemAnalysis(): void {
    const itemId = +this.itemAnalItemId;
    if (!itemId || !this.selected || !this.puuid) return;
    this.itemAnalResult = null;
    this.itemAnalError  = '';

    const matchupMap = new Map<string, { games: number; wins: number }>();
    for (const m of this.matches) {
      const p = m.info.participants.find(x => x.puuid === this.puuid);
      if (!p || p.championName !== this.selected) continue;
      if (m.info.gameMode !== 'CLASSIC' || !p.teamPosition) continue;
      const hasItem = [p.item0,p.item1,p.item2,p.item3,p.item4,p.item5].includes(itemId);
      if (!hasItem) continue;
      const opp = m.info.participants.find(
        x => x.teamId !== p.teamId && x.teamPosition === p.teamPosition
      );
      if (!opp) continue;
      const e = matchupMap.get(opp.championName) ?? { games: 0, wins: 0 };
      e.games++; if (p.win) e.wins++;
      matchupMap.set(opp.championName, e);
    }

    const matchups = [...matchupMap.entries()]
      .map(([enemy, { games, wins }]) => ({
        enemy, games, wins, wr: Math.round((wins / games) * 100)
      }))
      .sort((a, b) => b.wr - a.wr || b.games - a.games);

    this.itemAnalResult = { matchups };
    this.cdr.detectChanges();
  }

  getMandatoryOpponents(): any[] {
    if (!this.itemAnalResult?.matchups) return [];
    return this.itemAnalResult.matchups.filter((m: any) => m.wr >= 65 && m.games >= 2);
  }

  getShardLabel(ri: number, si: number): string {
    return this.riotApi.STAT_SHARDS[ri]?.[si]?.label ?? '';
  }

  metaData:    any    = null;
  metaLoading  = false;
  metaError    = '';
  private metaCache = new Map<string, any>();

  get opggData()    { return this.metaData; }
  get opggLoading() { return this.metaLoading; }
  get opggError()   { return this.metaError; }

  buildLoading  = false;
  buildProgress = 0;
  itemBuildByPos: ItemUsage[][] = [];
  bootBuildItems: ItemUsage[]   = [];

  winBuildByPos:  ItemUsage[][] = [];
  lossBuildByPos: ItemUsage[][] = [];
  avgMinByPos: { win: number; loss: number }[] = [];
  buildTimingNote = '';

  private buildSub?: Subscription;
  private tlCache   = new Map<string, ItemEvent[]>();

  private buildsByPos:     Map<number, { count: number; wins: number }>[] = [];
  private winBuildsByPos:  Map<number, { count: number; wins: number }>[] = [];
  private lossBuildsByPos: Map<number, { count: number; wins: number }>[] = [];
  private minSumByPos:     { win: number; loss: number; winN: number; lossN: number }[] = [];
  private buildBoots  = new Map<number, { count: number; wins: number }>();
  buildDone  = 0;
  buildTotal = 0;

  constructor(
    public  riotApi:   RiotApiService,
    private sanitizer: DomSanitizer,
    private cdr:       ChangeDetectorRef
  ) {}

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['puuid']) {
      this.selected        = null;
      this.detail          = null;
      this.itemBuildByPos  = [];
      this.bootBuildItems  = [];
      this.opponentFilter  = '';
      this.opponents       = [];
      this.tlCache.clear();
      this.champBuildCache.clear();
      this.champInventoryCache.clear();
      this.cancelBuild();
    }
    if (changes['matches'] || changes['puuid']) {
      this.buildChampList();
      if (this.selected) {
        this.opponents      = this.buildOpponents(this.selected);
        this.detail         = this.buildDetail(this.selected);
        this.inventoryItems = this.buildInventoryItems(this.selected);
        this.loadBuilds();
      } else if (this.champList.length > 0) {
        this.selectChamp(this.champList[0].championName);
      }
    }
  }

  ngOnDestroy(): void { this.cancelBuild(); }

  selectChamp(name: string): void {
    if (this.selected === name) return;
    this.cancelBuild();
    this.selected        = name;
    this.opponentFilter  = '';
    this.opponents       = this.buildOpponents(name);
    this.matchupOpponent = null;
    this.detail          = this.buildDetail(name);
    this.inventoryItems  = this.buildInventoryItems(name);
    this.champInventoryCache.set(name, this.inventoryItems);
    this.buildRuneStats(name);
    this.loadOpgg(name);
    this.itemAnalItemId = 0;
    this.itemAnalResult = null;
    this.itemAnalError  = '';

    const cacheKey = this.cacheKey(name);
    if (this.champBuildCache.has(cacheKey)) {
      const c = this.champBuildCache.get(cacheKey)!;
      this.itemBuildByPos = c.items;
      this.bootBuildItems = c.boot;
      this.buildLoading   = false;
      this.buildProgress  = 100;
    } else {
      this.itemBuildByPos = [];
      this.bootBuildItems = [];
      this.loadBuilds();
    }
  }

  @HostListener('document:click')
  onDocumentClick(): void { this.oppDropdownOpen = false; }

  toggleOppDropdown(e: Event): void {
    e.stopPropagation();
    this.oppDropdownOpen = !this.oppDropdownOpen;
  }

  setOpponentFilter(name: string): void {
    this.opponentFilter    = name;
    this.oppDropdownOpen   = false;
    this.champBuildCache.delete(this.cacheKey(this.selected ?? ''));
    this.cancelBuild();
    if (this.selected) {
      this.detail         = this.buildDetail(this.selected);
      this.inventoryItems = this.buildInventoryItems(this.selected);
      this.itemBuildByPos = [];
      this.bootBuildItems = [];
      this.loadBuilds();
    }
  }

  getItemTooltip(id: number): string {
    const d = this.riotApi.getItemDetail(id);
    if (!d) return '';
    return d.stats ? `${d.name}\n${d.gold}g · ${d.stats}` : `${d.name}\n${d.gold}g`;
  }

  getRecentForm(perGame: PerGameStat[]): PerGameStat[] {
    return [...perGame].reverse().slice(0, 10);
  }

  getStreak(perGame: PerGameStat[]): { count: number; win: boolean } | null {
    if (!perGame.length) return null;
    const last = perGame[perGame.length - 1];
    let count = 0;
    for (let i = perGame.length - 1; i >= 0; i--) {
      if (perGame[i].won === last.won) count++;
      else break;
    }
    return count >= 2 ? { count, win: last.won } : null;
  }

  getDmgShare(perGame: PerGameStat[]): number {
    return this.detail ? Math.round(this.detail.avgDmg / 1000) : 0;
  }

  winrate(e: ChampionListEntry): number { return Math.round((e.wins / e.games) * 100); }

  kda(e: ChampionListEntry): string {
    const d = (e.deaths / e.games) || 1;
    return (((e.kills + e.assists) / e.games) / d).toFixed(2);
  }

  getSplashStyle(name: string): SafeStyle {
    return this.sanitizer.bypassSecurityTrustStyle(
      `url(https://ddragon.leagueoflegends.com/cdn/img/champion/splash/${name}_0.jpg)`
    );
  }

  positionLabel(pos: string): string { return POS_LABEL[pos] ?? pos; }

  csDiffClass():  string { return !this.detail ? '' : (this.detail.csPerMin >= this.rankAvg.cs  ? 'vs-good' : 'vs-bad'); }
  dmgDiffClass(): string { return !this.detail ? '' : (this.detail.avgDmg   >= this.rankAvg.dmg ? 'vs-good' : 'vs-bad'); }

  csDiffStr(): string {
    if (!this.detail) return '';
    const d = this.detail.csPerMin - this.rankAvg.cs;
    return (d >= 0 ? '+' : '') + d.toFixed(1);
  }
  dmgDiffStr(): string {
    if (!this.detail) return '';
    const d = Math.round(this.detail.avgDmg - this.rankAvg.dmg);
    return (d >= 0 ? '+' : '') + Math.round(d / 1000) + 'k';
  }

  ordinal(n: number): string {
    return n === 1 ? '1er' : n === 2 ? '2º' : `${n}º`;
  }

  toggleMatchupOpponent(name: string): void {
    this.matchupOpponent = this.matchupOpponent === name ? null : name;
  }

  getMatchupHistory(): Array<{ match: Match; me: Participant; opp: Participant; cspm: number; myItems: number[]; oppItems: number[] }> {
    if (!this.matchupOpponent || !this.selected) return [];
    const result: Array<{ match: Match; me: Participant; opp: Participant; cspm: number; myItems: number[]; oppItems: number[] }> = [];
    for (const m of this.matches) {
      const me = m.info.participants.find(x => x.puuid === this.puuid);
      if (!me || me.championName !== this.selected) continue;
      if (m.info.gameMode !== 'CLASSIC' || !me.teamPosition) continue;
      const opp = m.info.participants.find(
        x => x.teamId !== me.teamId && x.teamPosition === me.teamPosition && x.championName === this.matchupOpponent
      );
      if (!opp) continue;
      const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
      const getItems = (p: Participant) =>
        [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5]
          .filter(id => this.isNonBootItem(id));
      result.push({
        match: m, me, opp,
        cspm: m.info.gameDuration > 0 ? (cs / m.info.gameDuration) * 60 : 0,
        myItems:  getItems(me),
        oppItems: getItems(opp),
      });
    }
    return result.sort((a, b) => b.match.info.gameCreation - a.match.info.gameCreation);
  }

  loadOpgg(name: string): void {
    const pos = (this.detail?.topPosition || 'adc').toLowerCase()
      .replace('bottom','adc').replace('utility','support').replace('jungle','jungle').replace('middle','mid');
    const key = `${name}_${pos}`;
    if (this.metaCache.has(key)) {
      this.metaData    = this.metaCache.get(key);
      this.metaLoading = false;
      this.metaError   = '';
      this.cdr.detectChanges();
      return;
    }
    this.metaData    = null;
    this.metaLoading = true;
    this.metaError   = '';
    this.riotApi.getOpggBuild(name, pos).subscribe({
      next: (data) => {
        if (data.error) { this.metaError = data.error; }
        else { this.metaData = data; this.metaCache.set(key, data); }
        this.metaLoading = false;
        this.cdr.detectChanges();
      },
      error: () => {
        this.metaError   = 'No se pudo conectar con OP.GG';
        this.metaLoading = false;
        this.cdr.detectChanges();
      }
    });
  }

  formatSkillOrder(order: string): { skill: string; level: number }[] {
    return (order || '').split('').map((s, i) => ({ skill: s, level: i + 1 }));
  }

  getMetaComparison(): { personal: number; meta: number | null; diff: string; good: boolean } | null {
    if (!this.detail || !this.metaData?.globalWr) return null;
    const personal = this.detail.wr;
    const meta     = this.metaData.globalWr;
    const diff     = personal - meta;
    return { personal, meta, diff: (diff >= 0 ? '+' : '') + diff.toFixed(1) + '%', good: diff >= 0 };
  }

  readonly RADAR_CX = 120; readonly RADAR_CY = 120; readonly RADAR_R = 90;
  readonly RADAR_LABELS = ['WR', 'KDA', 'CS/min', 'Daño', 'Visión'];

  getRadarAxisEnd(i: number): { x: number; y: number } {
    const angle = ((i * 72) - 90) * Math.PI / 180;
    return {
      x: this.RADAR_CX + this.RADAR_R * Math.cos(angle),
      y: this.RADAR_CY + this.RADAR_R * Math.sin(angle),
    };
  }

  getRadarLabelPos(i: number): { x: number; y: number } {
    const angle = ((i * 72) - 90) * Math.PI / 180;
    const r = this.RADAR_R + 22;
    return {
      x: this.RADAR_CX + r * Math.cos(angle),
      y: this.RADAR_CY + r * Math.sin(angle),
    };
  }

  getRadarRingPoints(fraction: number): string {
    return [0,1,2,3,4].map(i => {
      const angle = ((i * 72) - 90) * Math.PI / 180;
      const r = this.RADAR_R * fraction;
      return `${(this.RADAR_CX + r * Math.cos(angle)).toFixed(1)},${(this.RADAR_CY + r * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
  }

  private radarPolygon(pcts: number[]): string {
    return pcts.map((pct, i) => {
      const angle = ((i * 72) - 90) * Math.PI / 180;
      const r = this.RADAR_R * Math.max(Math.min(pct / 100, 1), 0.05);
      return `${(this.RADAR_CX + r * Math.cos(angle)).toFixed(1)},${(this.RADAR_CY + r * Math.sin(angle)).toFixed(1)}`;
    }).join(' ');
  }

  getMyRadarPolygon(): string {
    const rows = this.getEuwComparison();
    if (!rows.length) return '';
    return this.radarPolygon(rows.map(r => r.pctMine));
  }

  getEuwRadarPolygon(): string {
    const rows = this.getEuwComparison();
    if (!rows.length) return '';
    return this.radarPolygon(rows.map(r => r.pctEuw));
  }

  getRadarDotPos(rowIdx: number, type: 'mine' | 'euw'): { x: number; y: number } {
    const rows = this.getEuwComparison();
    const pct  = rows[rowIdx] ? (type === 'mine' ? rows[rowIdx].pctMine : rows[rowIdx].pctEuw) : 0;
    const angle = ((rowIdx * 72) - 90) * Math.PI / 180;
    const r = this.RADAR_R * Math.max(Math.min(pct / 100, 1), 0.05);
    return { x: parseFloat((this.RADAR_CX + r * Math.cos(angle)).toFixed(1)), y: parseFloat((this.RADAR_CY + r * Math.sin(angle)).toFixed(1)) };
  }

  getEuwComparison(): Array<{ label: string; mine: string; euw: string; diff: string; good: boolean; pctMine: number; pctEuw: number; icon: string; desc: string; percentile: string }> {
    if (!this.detail) return [];

    type Row = { label: string; mine: string; euw: string; diff: string; good: boolean; pctMine: number; pctEuw: number; icon: string; desc: string; percentile: string };
    const rows: Row[] = [];

    const pct = (val: number, ref: number, scale: number): string => {
      const z = (val - ref) / scale;
      const p = Math.min(99, Math.max(1, Math.round(50 + z * 25)));
      return `Top ${100 - p}%`;
    };

    const euwWr  = this.metaData?.globalWr ?? 50;
    const myWr   = this.detail.wr;
    const wrDiff = myWr - euwWr;
    rows.push({
      label: 'Winrate', icon: '🏆',
      mine: `${myWr}%`, euw: `${euwWr}%`,
      diff: (wrDiff >= 0 ? '+' : '') + wrDiff.toFixed(1) + '%',
      good: wrDiff >= 0,
      pctMine: myWr, pctEuw: euwWr,
      desc: 'Porcentaje de partidas ganadas. Por encima de 50% subes elo con consistencia.',
      percentile: pct(myWr, euwWr, 8),
    });

    const myKda  = this.detail.avgDeaths > 0
      ? (this.detail.avgKills + this.detail.avgAssists) / this.detail.avgDeaths
      : this.detail.avgKills + this.detail.avgAssists;
    const euwKda = this.rankAvg.kda ?? 2.5;
    const kdaDiff = myKda - euwKda;
    rows.push({
      label: 'KDA', icon: '⚔️',
      mine: myKda.toFixed(2), euw: euwKda.toFixed(2),
      diff: (kdaDiff >= 0 ? '+' : '') + kdaDiff.toFixed(2),
      good: kdaDiff >= 0,
      pctMine: Math.min(myKda  / 6 * 100, 100),
      pctEuw:  Math.min(euwKda / 6 * 100, 100),
      desc: `${this.detail.avgKills.toFixed(1)}/${this.detail.avgDeaths.toFixed(1)}/${this.detail.avgAssists.toFixed(1)} medio · KDA ≥ 3 es excelente.`,
      percentile: pct(myKda, euwKda, 0.7),
    });

    const myCs  = this.detail.csPerMin;
    const euwCs = this.rankAvg.cs;
    const csDiff = myCs - euwCs;
    const goldPerMin = Math.round(Math.abs(csDiff) * 21);
    rows.push({
      label: 'CS/min', icon: '🌾',
      mine: myCs.toFixed(1) + '/m', euw: euwCs.toFixed(1) + '/m',
      diff: (csDiff >= 0 ? '+' : '') + csDiff.toFixed(1) + '/m',
      good: csDiff >= 0,
      pctMine: Math.min(myCs  / 12 * 100, 100),
      pctEuw:  Math.min(euwCs / 12 * 100, 100),
      desc: `Diferencia de ${Math.abs(csDiff).toFixed(1)}/m = ~${goldPerMin}g/min ${csDiff >= 0 ? 'de ventaja' : 'de desventaja'} en recursos.`,
      percentile: pct(myCs, euwCs, 1.2),
    });

    const myDmg  = this.detail.avgDmg;
    const euwDmg = this.rankAvg.dmg;
    const dmgDiff = myDmg - euwDmg;
    rows.push({
      label: 'Daño/partida', icon: '💥',
      mine: (myDmg  / 1000).toFixed(1) + 'k',
      euw:  (euwDmg / 1000).toFixed(1) + 'k',
      diff: (dmgDiff >= 0 ? '+' : '') + Math.round(dmgDiff / 1000) + 'k',
      good: dmgDiff >= 0,
      pctMine: Math.min(myDmg  / 50000 * 100, 100),
      pctEuw:  Math.min(euwDmg / 50000 * 100, 100),
      desc: 'Daño a campeones enemigos. Indica cuánto presionas en peleas de equipo.',
      percentile: pct(myDmg, euwDmg, 5000),
    });

    const myVis  = this.detail.avgVision;
    const euwVis = this.rankAvg.vision ?? 1.1;
    const visDiff = myVis - euwVis;
    rows.push({
      label: 'Visión/min', icon: '👁️',
      mine: myVis.toFixed(2) + '/m', euw: euwVis.toFixed(2) + '/m',
      diff: (visDiff >= 0 ? '+' : '') + visDiff.toFixed(2) + '/m',
      good: visDiff >= 0,
      pctMine: Math.min(myVis  / 3 * 100, 100),
      pctEuw:  Math.min(euwVis / 3 * 100, 100),
      desc: 'Puntuación de visión por minuto. Wards, control wards y quitar wards enemigos.',
      percentile: pct(myVis, euwVis, 0.25),
    });

    return rows;
  }

  getWorstStat(): string {
    const rows = this.getEuwComparison();
    if (!rows.length) return '';
    const worst = rows.filter(r => !r.good).sort((a, b) => (a.pctMine - a.pctEuw) - (b.pctMine - b.pctEuw))[0];
    return worst?.label ?? '';
  }

  getBestStat(): string {
    const rows = this.getEuwComparison();
    if (!rows.length) return '';
    const best = rows.filter(r => r.good).sort((a, b) => (b.pctMine - b.pctEuw) - (a.pctMine - a.pctEuw))[0];
    return best?.label ?? '';
  }

  getMergedMatchups(type: 'good' | 'bad'): Array<{
    championName: string; personalGames: number; personalWr: number;
    globalWr: number | null; delta: number;
  }> {
    if (!this.detail) return [];

    const personal = type === 'good' ? this.detail.goodMatchups : this.detail.badMatchups;
    const global   = type === 'good' ? this.metaData?.easiest : this.metaData?.hardest;

    const globalMap = new Map<string, number>(
      (global || []).map((g: any) => [g.champion, g.winRate])
    );

    return personal.map(m => ({
      championName:  m.championName,
      personalGames: m.games,
      personalWr:    m.wr,
      globalWr:      globalMap.get(m.championName) ?? null,
      delta:         m.delta,
    }));
  }

  getOpggDivergentItems(): number[] {
    if (!this.opggData?.coreItems?.length || !this.inventoryItems.length) return [];
    const metaIds = new Set<number>(
      this.opggData.coreItems.flatMap((c: any) => c.ids || [])
    );
    return this.inventoryItems
      .filter(i => !metaIds.has(i.id) && i.pct >= 30)
      .map(i => i.id)
      .slice(0, 4);
  }

  formatMin(m: number): string {
    if (!m || m <= 0) return '—';
    const min = Math.floor(m);
    const sec = Math.round((m - min) * 60);
    return `${min}:${sec.toString().padStart(2,'0')}`;
  }

  get hasSplitBuilds(): boolean {
    return this.winBuildByPos.some(p => p.length > 0) || this.lossBuildByPos.some(p => p.length > 0);
  }

  formatMatchDate(ts: number): string {
    const d = new Date(ts);
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
  }

  formatDur(s: number): string {
    const m = Math.floor(s / 60); const sec = s % 60;
    return `${m}m ${sec.toString().padStart(2,'0')}s`;
  }

  private cacheKey(champName: string): string {
    return this.opponentFilter ? `${champName}::${this.opponentFilter}` : champName;
  }

  private filteredMatches(champName: string): Match[] {
    let ms = this.matches.filter(m =>
      m.info.participants.find(x => x.puuid === this.puuid)?.championName === champName
    );
    if (this.opponentFilter) {
      ms = ms.filter(m => {
        const me = m.info.participants.find(x => x.puuid === this.puuid);
        if (!me || !me.teamPosition) return false;
        return m.info.participants.some(
          x => x.teamId !== me.teamId && x.teamPosition === me.teamPosition &&
               x.championName === this.opponentFilter
        );
      });
    }
    return ms;
  }

  private buildOpponents(champName: string): string[] {
    const seen = new Map<string, number>();
    for (const m of this.matches) {
      const me = m.info.participants.find(x => x.puuid === this.puuid);
      if (!me || me.championName !== champName || !me.teamPosition) continue;
      if (m.info.gameMode !== 'CLASSIC') continue;
      const opp = m.info.participants.find(
        x => x.teamId !== me.teamId && x.teamPosition === me.teamPosition
      );
      if (opp) seen.set(opp.championName, (seen.get(opp.championName) ?? 0) + 1);
    }
    return [...seen.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name]) => name);
  }

  private buildRuneStats(champName: string): void {
    const matches = this.filteredMatches(champName)
      .filter(m => (m.info.queueId === 420 || m.info.queueId === 0));

    const withPerks = matches.filter(m => {
      const p = m.info.participants.find(x => x.puuid === this.puuid);
      return !!p?.perks;
    });

    this.runeGamesTotal = withPerks.length;
    if (!withPerks.length) {
      this.primaryRunePaths = []; this.secondaryRuneStats = []; this.statShardStats = [];
      return;
    }

    const runeCount = new Map<number, { count: number; wins: number }>();
    const bump = (id: number, win: boolean) => {
      const e = runeCount.get(id) ?? { count: 0, wins: 0 };
      e.count++; if (win) e.wins++;
      runeCount.set(id, e);
    };

    const pathCount = new Map<number, { count: number; wins: number }>();

    for (const m of withPerks) {
      const p   = m.info.participants.find(x => x.puuid === this.puuid)!;
      const win = p.win;
      const primary = p.perks!.styles.find(s => s.description === 'primaryStyle');
      const sub     = p.perks!.styles.find(s => s.description === 'subStyle');

      if (primary) {
        const pe = pathCount.get(primary.style) ?? { count: 0, wins: 0 };
        pe.count++; if (win) pe.wins++;
        pathCount.set(primary.style, pe);
        primary.selections.forEach(s => bump(s.perk, win));
      }
      if (sub) sub.selections.forEach(s => bump(s.perk, win));
      if (p.perks!.statPerks) {
        bump(p.perks!.statPerks.offense,  win);
        bump(p.perks!.statPerks.flex,     win);
        bump(p.perks!.statPerks.defense,  win);
      }
    }

    const total = withPerks.length;
    const toStat = (id: number): RuneStat => {
      const e = runeCount.get(id) ?? { count: 0, wins: 0 };
      return {
        id,
        count: e.count,
        wins:  e.wins,
        pct:   e.count ? Math.round((e.count / total) * 100) : 0,
        wr:    e.count ? Math.round((e.wins  / e.count) * 100) : 0,
      };
    };

    this.primaryRunePaths = this.riotApi.runePaths.map(path => {
      const pe  = pathCount.get(path.id) ?? { count: 0, wins: 0 };
      return {
        pathId: path.id,
        count:  pe.count,
        pct:    Math.round((pe.count / total) * 100),
        wr:     pe.count ? Math.round((pe.wins / pe.count) * 100) : 0,
        slots:  (path.slots as any[]).map((slot: any) => ({
          runes: (slot.runes as any[])
            .map((r: any) => toStat(r.id))
            .sort((a, b) => b.count - a.count),
        })),
      } as RunePathStat;
    }).filter(p => p.count > 0).sort((a, b) => b.count - a.count);

    this.secondaryRuneStats = this.riotApi.runePaths.map(path =>
      (path.slots as any[]).slice(1).flatMap((slot: any) =>
        (slot.runes as any[]).map((r: any) => toStat(r.id))
      ).filter(r => r.count > 0).sort((a, b) => b.count - a.count)
    ).filter(arr => arr.length > 0);

    const shardRows = [
      [5008, 5005, 5007],
      [5008, 5002, 5003],
      [5001, 5002, 5003],
    ];
    this.statShardStats = shardRows.map(row => row.map(id => toStat(id)));
  }

  private buildChampList(): void {
    const map = new Map<string, ChampionListEntry>();
    for (const m of this.matches) {
      const p = m.info.participants.find(x => x.puuid === this.puuid);
      if (!p) continue;
      if (!map.has(p.championName)) {
        map.set(p.championName, {
          championName: p.championName, games: 0, wins: 0,
          kills: 0, deaths: 0, assists: 0,
          totalCs: 0, totalDuration: 0, totalDmg: 0
        });
      }
      const s = map.get(p.championName)!;
      s.games++; if (p.win) s.wins++;
      s.kills   += p.kills; s.deaths  += p.deaths; s.assists += p.assists;
      s.totalCs += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
      s.totalDuration += m.info.gameDuration;
      s.totalDmg      += p.totalDamageDealtToChampions || 0;
    }
    this.champList = [...map.values()].sort((a, b) => b.games - a.games);
  }

  private buildDetail(champName: string): ChampionDetailData | null {
    const champMatches = this.filteredMatches(champName)
      .filter(m => m.info.queueId === 420 || m.info.queueId === 0)
      .sort((a, b) => a.info.gameCreation - b.info.gameCreation);

    if (champMatches.length === 0) return null;

    let games = 0, wins = 0, kills = 0, deaths = 0, assists = 0;
    let totalCs = 0, totalDuration = 0, totalDmg = 0, totalKp = 0, totalVision = 0;

    const bootCounts  = new Map<number, { count: number; wins: number }>();
    const spellCounts = new Map<string, { s1: number; s2: number; count: number; wins: number }>();
    const matchupMap  = new Map<string, { games: number; wins: number }>();
    const positionMap = new Map<string, number>();
    const perGameRaw: { cs: number; deaths: number; won: boolean; date: number }[] = [];

    for (const m of champMatches) {
      const p = m.info.participants.find(x => x.puuid === this.puuid)!;
      games++; if (p.win) wins++;
      kills += p.kills; deaths += p.deaths; assists += p.assists;
      const cs = (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
      totalCs       += cs;
      totalDuration += m.info.gameDuration;
      totalDmg      += p.totalDamageDealtToChampions || 0;
      totalVision   += p.visionScore || 0;

      const teamKills = m.info.participants
        .filter(x => x.teamId === p.teamId)
        .reduce((sum, x) => sum + x.kills, 0);
      totalKp += teamKills > 0 ? (p.kills + p.assists) / teamKills : 0;

      if (p.teamPosition) {
        positionMap.set(p.teamPosition, (positionMap.get(p.teamPosition) ?? 0) + 1);
      }

      const csPerMin = m.info.gameDuration > 0 ? (cs / m.info.gameDuration) * 60 : 0;
      perGameRaw.push({ cs: csPerMin, deaths: p.deaths, won: p.win, date: m.info.gameCreation });

      for (const id of [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6]) {
        if (id > 0 && BOOT_IDS.has(id)) {
          const b = bootCounts.get(id) ?? { count: 0, wins: 0 };
          b.count++; if (p.win) b.wins++;
          bootCounts.set(id, b);
        }
      }

      if (p.summoner1Id && p.summoner2Id) {
        const lo = Math.min(p.summoner1Id, p.summoner2Id);
        const hi = Math.max(p.summoner1Id, p.summoner2Id);
        const key = `${lo}_${hi}`;
        if (!spellCounts.has(key)) spellCounts.set(key, { s1: lo, s2: hi, count: 0, wins: 0 });
        spellCounts.get(key)!.count++;
        if (p.win) spellCounts.get(key)!.wins++;
      }

      if (m.info.gameMode === 'CLASSIC' && p.teamPosition) {
        const opp = m.info.participants.find(x => x.teamId !== p.teamId && x.teamPosition === p.teamPosition);
        if (opp) {
          if (!matchupMap.has(opp.championName)) matchupMap.set(opp.championName, { games: 0, wins: 0 });
          const mu = matchupMap.get(opp.championName)!;
          mu.games++; if (p.win) mu.wins++;
        }
      }
    }

    const globalWr = wins / games;
    const avgKp = Math.round((totalKp / games) * 100);
    const topPosition = [...positionMap.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

    const topBoots = [...bootCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count).slice(0, 6)
      .map(([id, { count, wins }]) => ({
        id, count,
        pct: Math.round((count / games) * 100),
        wr:  Math.round((wins / count) * 100),
      }));

    const topSpells = [...spellCounts.values()]
      .sort((a, b) => b.count - a.count).slice(0, 4)
      .map(s => ({ ...s, pct: Math.round((s.count / games) * 100), wr: Math.round((s.wins / s.count) * 100) }));

    const allMatchups = [...matchupMap.entries()]
      .filter(([, v]) => v.games >= 2)
      .map(([name, v]) => ({
        championName: name, games: v.games, wins: v.wins,
        wr:    Math.round((v.wins  / v.games) * 100),
        delta: Math.round(((v.wins / v.games) - globalWr) * 100)
      }))
      .sort((a, b) => b.delta - a.delta);

    const csVals  = perGameRaw.map(g => g.cs);
    const csMin   = Math.min(...csVals);
    const csMax   = Math.max(...csVals);
    const csRange = csMax - csMin || 1;
    const csAvg   = csVals.reduce((a, b) => a + b, 0) / csVals.length;

    const toY = (v: number) => CPAD + (1 - (v - csMin) / csRange) * (CH - CPAD * 2);
    const toX = (i: number) => perGameRaw.length <= 1 ? CW / 2 : (i / (perGameRaw.length - 1)) * CW;

    const csChartLine = perGameRaw.map((g, i) =>
      `${toX(i).toFixed(1)},${toY(g.cs).toFixed(1)}`
    ).join(' ');

    const refClipped = Math.min(Math.max(this.rankAvg.cs, csMin), csMax);
    const csRefY = perGameRaw.length > 1 ? toY(refClipped) : null;

    const deathVals = perGameRaw.map(g => g.deaths);
    const deathsMax = Math.max(...deathVals, 1);
    const deathsAvg = deathVals.reduce((a, b) => a + b, 0) / deathVals.length;

    const perGame: PerGameStat[] = perGameRaw.map((g, i) => ({
      cs:       g.cs,
      deaths:   g.deaths,
      won:      g.won,
      date:     g.date,
      csX:      toX(i),
      csY:      toY(g.cs),
      deathPct: (g.deaths / deathsMax) * 100,
      csPct:    csMax > 0 ? (g.cs / csMax) * 100 : 0,
      csGood:   g.cs >= this.rankAvg.cs,
    }));

    const periodLabels = ['Inicio temporada', 'Mitad temporada', 'Reciente'];
    const trendPeriods: TrendPeriod[] = [];
    if (champMatches.length >= 6) {
      const third = Math.floor(champMatches.length / 3);
      const slices = [
        champMatches.slice(0, third),
        champMatches.slice(third, third * 2),
        champMatches.slice(third * 2),
      ];
      for (let pi = 0; pi < 3; pi++) {
        const ms = slices[pi];
        let pg = 0, pw = 0, pk = 0, pd = 0, pa = 0, pcs = 0, pdur = 0;
        for (const m of ms) {
          const p = m.info.participants.find(x => x.puuid === this.puuid)!;
          pg++; if (p.win) pw++;
          pk += p.kills; pd += p.deaths; pa += p.assists;
          pcs  += (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
          pdur += m.info.gameDuration;
        }
        const kda = pd > 0 ? ((pk + pa) / pg) / (pd / pg) : (pk + pa) / pg;
        trendPeriods.push({
          label:  periodLabels[pi],
          games:  pg, wins: pw,
          wr:     Math.round((pw / pg) * 100),
          avgKda: Math.round(kda * 100) / 100,
          avgCs:  pdur > 0 ? Math.round((pcs / pdur) * 600) / 10 : 0,
        });
      }
    }

    let durWin = 0, durWinN = 0, durLoss = 0, durLossN = 0;
    for (const m of champMatches) {
      const p = m.info.participants.find(x => x.puuid === this.puuid)!;
      if (p.win) { durWin += m.info.gameDuration; durWinN++; }
      else        { durLoss += m.info.gameDuration; durLossN++; }
    }

    return {
      championName: champName, games, wins,
      wr:          Math.round((wins / games) * 100),
      avgKills:    kills   / games,
      avgDeaths:   deaths  / games,
      avgAssists:  assists / games,
      csPerMin:    totalDuration > 0 ? (totalCs / totalDuration) * 60 : 0,
      avgDmg:      totalDmg / games,
      avgVision:   totalDuration > 0 ? (totalVision / totalDuration) * 60 : 0,
      avgKp, topPosition,
      topBoots, topSpells,
      goodMatchups: allMatchups.filter(m => m.delta > 0).slice(0, 5),
      badMatchups:  [...allMatchups].filter(m => m.delta < 0).reverse().slice(0, 5),
      perGame, csChartLine, csRefY,
      csMinVal: csMin, csMaxVal: csMax, csAvgVal: csAvg,
      deathsMax, deathsAvg,
      trendPeriods,
      avgGameMin:     totalDuration / games / 60,
      avgGameMinWin:  durWinN  > 0 ? durWin  / durWinN  / 60 : 0,
      avgGameMinLoss: durLossN > 0 ? durLoss / durLossN / 60 : 0,
    };
  }

  private isKeepableItem(id: number): boolean {
    if (!id) return false;
    if (!this.riotApi.isCompleteItem(id)) return false;
    return true;
  }

  private isNonBootItem(id: number): boolean {
    return this.isKeepableItem(id) && !BOOT_IDS.has(id);
  }

  private buildInventoryItems(champName: string): ItemUsage[] {
    const champMatches = this.filteredMatches(champName)
      .filter(m => m.info.queueId === 420 || m.info.queueId === 0);
    if (!champMatches.length) return [];

    const total      = champMatches.length;
    const itemCounts = new Map<number, { count: number; wins: number }>();

    for (const m of champMatches) {
      const p    = m.info.participants.find(x => x.puuid === this.puuid)!;
      const seen = new Set<number>();
      for (const id of [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5]) {
        if (this.isKeepableItem(id) && !seen.has(id)) {
          seen.add(id);
          const e = itemCounts.get(id) ?? { count: 0, wins: 0 };
          e.count++; if (p.win) e.wins++;
          itemCounts.set(id, e);
        }
      }
    }

    return [...itemCounts.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 12)
      .map(([id, { count, wins }]) => ({
        id, count,
        pct: Math.round((count / total) * 100),
        wr:  Math.round((wins / count) * 100),
      }));
  }

  private cancelBuild(): void {
    this.buildSub?.unsubscribe();
    this.buildSub        = undefined;
    this.buildLoading    = false;
    this.buildProgress   = 0;
    this.itemBuildByPos  = [];
    this.bootBuildItems  = [];
    this.winBuildByPos   = [];
    this.lossBuildByPos  = [];
    this.avgMinByPos     = [];
    this.buildTimingNote = '';
  }

  private getFinalItems(m: Match): { nonBoots: number[]; boot: number | null; win: boolean } {
    const p = m.info.participants.find(x => x.puuid === this.puuid);
    if (!p) return { nonBoots: [], boot: null, win: false };
    const allSlots = [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6];
    const nonBoots = allSlots.filter(id => this.isNonBootItem(id));
    const boot     = allSlots.find(id => id > 0 && BOOT_IDS.has(id)) ?? null;
    return { nonBoots, boot, win: p.win };
  }

  private posMapToUsage(posMap: Map<number, { count: number; wins: number }>, maxItems = 6): ItemUsage[] {
    const entries = [...posMap.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, maxItems);
    const total   = entries.reduce((s, [, v]) => s + v.count, 0) || 1;
    return entries.map(([id, { count, wins }]) => ({
      id, count,
      pct: Math.round((count / total) * 100),
      wr:  Math.round((wins  / count) * 100),
    }));
  }

  private recomputeBuild(): void {
    this.itemBuildByPos  = this.buildsByPos.map(m  => this.posMapToUsage(m));
    this.winBuildByPos   = this.winBuildsByPos.map(m  => this.posMapToUsage(m, 4));
    this.lossBuildByPos  = this.lossBuildsByPos.map(m => this.posMapToUsage(m, 4));

    this.avgMinByPos = this.minSumByPos.map(t => ({
      win:  t.winN  > 0 ? t.win  / t.winN  : 0,
      loss: t.lossN > 0 ? t.loss / t.lossN : 0,
    }));

    const t0 = this.avgMinByPos[0];
    if (t0 && t0.win > 0 && t0.loss > 0) {
      const diff = t0.loss - t0.win;
      if (diff > 1) {
        this.buildTimingNote =
          `⚠ En derrota compras el primer objeto ${diff.toFixed(1)} min más tarde (${t0.win.toFixed(1)} min ganando vs ${t0.loss.toFixed(1)} min perdiendo). Farmea más eficientemente o vuelve antes.`;
      } else if (diff < -1) {
        this.buildTimingNote =
          `En derrota compras el primer objeto ${(-diff).toFixed(1)} min antes (${t0.loss.toFixed(1)} min), quizás vuelves demasiado pronto y pierdes CS.`;
      } else {
        this.buildTimingNote = '';
      }
    } else {
      this.buildTimingNote = '';
    }

    const bootEntries = [...this.buildBoots.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 4);
    const bootTotal   = bootEntries.reduce((s, [, v]) => s + v.count, 0) || 1;
    this.bootBuildItems = bootEntries.map(([id, { count, wins }]) => ({
      id, count,
      pct: Math.round((count / bootTotal) * 100),
      wr:  Math.round((wins  / count) * 100),
    }));
  }

  private loadBuilds(): void {
    if (!this.selected || !this.puuid) return;

    const champMatches = this.filteredMatches(this.selected)
      .filter(m => m.info.queueId === 420 || m.info.queueId === 0)
      .sort((a, b) => a.info.gameCreation - b.info.gameCreation);

    if (champMatches.length === 0) return;

    this.buildLoading    = true;
    this.buildProgress   = 0;
    this.buildsByPos     = [0,1,2,3,4,5].map(() => new Map<number,{ count: number; wins: number }>());
    this.winBuildsByPos  = [0,1,2,3,4,5].map(() => new Map<number,{ count: number; wins: number }>());
    this.lossBuildsByPos = [0,1,2,3,4,5].map(() => new Map<number,{ count: number; wins: number }>());
    this.minSumByPos     = [0,1,2,3,4,5].map(() => ({ win: 0, loss: 0, winN: 0, lossN: 0 }));
    this.buildBoots      = new Map();
    this.buildDone       = 0;
    this.buildTotal      = champMatches.length;

    const puuid = this.puuid;
    const ids   = champMatches.map(m => m.metadata.matchId);

    // Pre-warm the timeline cache with a single batch query to avoid per-match delays
    this.riotApi.getTimelinesBatch(ids, puuid).pipe(take(1)).subscribe({
      next: (batchMap) => {
        for (const [matchId, events] of batchMap) {
          if (!this.tlCache.has(matchId)) this.tlCache.set(matchId, events);
        }
        this.runBuildLoop(champMatches, puuid);
      },
      error: () => this.runBuildLoop(champMatches, puuid),
    });
  }

  private runBuildLoop(champMatches: Match[], puuid: string): void {
    this.buildSub = from(champMatches).pipe(
      concatMap((match, idx) => {
        const inMemory = this.tlCache.get(match.metadata.matchId);
        const { nonBoots, boot, win } = this.getFinalItems(match);

        const response$ = inMemory
          ? of({ events: inMemory })
          : (idx === 0
              ? this.riotApi.getTimeline(match.metadata.matchId, puuid)
              : timer(1200).pipe(switchMap(() => this.riotApi.getTimeline(match.metadata.matchId, puuid)))
            ).pipe(catchError(() => of({ events: [] as ItemEvent[] })));

        return response$.pipe(
          concatMap(resp => {
            if (!this.tlCache.has(match.metadata.matchId)) {
              this.tlCache.set(match.metadata.matchId, resp.events);
            }
            return of({ events: resp.events, nonBoots, boot, win });
          })
        );
      })
    ).subscribe({
      next: ({ events, nonBoots, boot, win }) => {
        if (boot) {
          const b = this.buildBoots.get(boot) ?? { count: 0, wins: 0 };
          b.count++; if (win) b.wins++;
          this.buildBoots.set(boot, b);
        }

        const itemTs = new Map<number, number>();
        for (const e of events) {
          if (e.type === 'ITEM_PURCHASED' && nonBoots.includes(e.itemId)) {
            if (!itemTs.has(e.itemId)) itemTs.set(e.itemId, e.ts);
          }
        }
        nonBoots
          .filter(id => itemTs.has(id))
          .sort((a, b) => (itemTs.get(a) ?? 0) - (itemTs.get(b) ?? 0))
          .forEach((id, pos) => {
            if (pos < 6) {
              const entry = this.buildsByPos[pos].get(id) ?? { count: 0, wins: 0 };
              entry.count++; if (win) entry.wins++;
              this.buildsByPos[pos].set(id, entry);

              const splitMap = win ? this.winBuildsByPos[pos] : this.lossBuildsByPos[pos];
              const se = splitMap.get(id) ?? { count: 0, wins: 0 };
              se.count++; if (win) se.wins++;
              splitMap.set(id, se);

              const minute = (itemTs.get(id) ?? 0) / 60000;
              const t = this.minSumByPos[pos];
              if (win) { t.win += minute; t.winN++; }
              else     { t.loss += minute; t.lossN++; }
            }
          });

        this.buildDone++;
        this.buildProgress = Math.round((this.buildDone / this.buildTotal) * 100);
        this.recomputeBuild();
        this.cdr.detectChanges();
      },
      complete: () => {
        this.buildLoading = false;
        this.recomputeBuild();
        if (this.selected) {
          this.champBuildCache.set(this.cacheKey(this.selected), {
            items: this.itemBuildByPos,
            boot:  this.bootBuildItems,
          });
        }
        this.cdr.detectChanges();
      },
      error: () => {
        this.buildLoading = false;
        this.cdr.detectChanges();
      }
    });
  }
}
