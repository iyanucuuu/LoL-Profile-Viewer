import { Component, Input, OnChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RankedEntry, Match, RiotApiService } from '../../services/riot-api';

export interface LpPoint {
  idx:       number;
  lp:        number;
  date:      Date;
  win:       boolean;
  delta:     number;
  champion:  string;
  kills:     number;
  deaths:    number;
  assists:   number;
  role:      string;
}
export interface DivLine    { y: number; label: string; color: string; absLp: number; }
export interface DeltaLabel { x: number; yMid: number; yTop: number; yBot: number; delta: number; win: boolean; }
export interface TierZone   { y1: number; y2: number; color: string; }

const AVG_WIN  =  20;
const AVG_LOSS = -17;

const TIER_ORDER = ['IRON','BRONZE','SILVER','GOLD','PLATINUM','EMERALD','DIAMOND'];
const TIER_NAMES = ['Iron','Bronze','Silver','Gold','Platinum','Emerald','Diamond'];
const DIV_NAMES  = ['IV','III','II','I'];

const TIER_COLORS: Record<string, string> = {
  iron:'#8b8989', bronze:'#ae6c3d', silver:'#a1a5ba',
  gold:'#c89b3c', platinum:'#1e9c8c', emerald:'#57bf5e',
  diamond:'#7677ce', master:'#9d48e8', grandmaster:'#e84848',
  challenger:'#f4c874',
};

function absLPfrom(tier: string, rank: string): number {
  const ti = TIER_ORDER.indexOf(tier.toUpperCase());
  if (ti === -1) return 2800;
  return ti * 400 + Math.max(DIV_NAMES.indexOf(rank.toUpperCase()), 0) * 100;
}
function labelFromAbs(absLP: number): string {
  if (absLP < 0) return 'Iron IV';
  const ti = Math.min(Math.floor(absLP / 400), TIER_NAMES.length - 1);
  const di = Math.floor((absLP % 400) / 100);
  return `${TIER_NAMES[ti]} ${DIV_NAMES[di]}`;
}
function colorFromAbs(absLP: number): string {
  if (absLP < 0) return TIER_COLORS['iron'];
  const ti = Math.min(Math.floor(absLP / 400), TIER_NAMES.length - 1);
  return TIER_COLORS[TIER_NAMES[ti].toLowerCase()] ?? '#4fb4d8';
}

@Component({
  selector: 'app-ranked-stats',
  imports: [CommonModule],
  templateUrl: './ranked-stats.html',
  styleUrl: './ranked-stats.css'
})
export class RankedStats implements OnChanges {
  @Input() ranked:  RankedEntry[] = [];
  @Input() matches: Match[]       = [];
  @Input() puuid    = '';

  lpPoints:      LpPoint[]     = [];
  divisionLines: DivLine[]     = [];
  deltaLabels:   DeltaLabel[]  = [];
  tierZones:     TierZone[]    = [];
  stepPolyline   = '';
  fillPolygon    = '';
  hoveredPt:     LpPoint | null = null;
  hoverX = 0; hoverY = 0;

  tierColor  = '#c89b3c';
  lpMin = 0; lpMax = 100;
  netLp = 0;
  periodWins   = 0;
  periodLosses = 0;

  peakIdx  = -1;
  troughIdx = -1;
  peakY  = 0;
  troughY = 0;

  dateRangeLabel = '';
  trendDir: 'up' | 'down' | 'flat' = 'flat';

  chartPage       = 0;
  private allRaw: { lp: number; date: Date; win: boolean; champion: string; kills: number; deaths: number; assists: number; role: string }[] = [];
  get chartTotalPages(): number { return Math.max(1, Math.ceil(this.allRaw.length / 20)); }
  get chartHasPrev():   boolean { return this.chartPage > 0; }
  get chartHasNext():   boolean { return this.chartPage < this.chartTotalPages - 1; }

  prevChartPage(): void { if (this.chartHasPrev) { this.chartPage--; this.renderPage(); } }
  nextChartPage(): void { if (this.chartHasNext) { this.chartPage++; this.renderPage(); } }

  readonly CW = 520; readonly CH = 180; readonly PAD = 16;
  readonly SW = 520; readonly SH = 14;

  constructor(public riotApi: RiotApiService) {}
  ngOnChanges(): void { this.buildLpChart(); }

  getSortedRanked(): RankedEntry[] {
    const order = ['RANKED_SOLO_5x5', 'RANKED_FLEX_SR'];
    return [...this.ranked].sort((a, b) => order.indexOf(a.queueType) - order.indexOf(b.queueType));
  }

  winrate(e: RankedEntry): number {
    const t = e.wins + e.losses;
    return t ? Math.round((e.wins / t) * 100) : 0;
  }

  onImgError(event: Event, tier: string) {
    const img = event.target as HTMLImageElement;
    if (!img.src.includes('mini')) img.src = this.riotApi.getRankedMiniUrl(tier);
    else img.style.display = 'none';
  }

  private buildLpChart(): void {
    const solo = this.ranked.find(r => r.queueType === 'RANKED_SOLO_5x5');
    if (!solo || !this.matches.length || !this.puuid) { this.lpPoints = []; return; }

    this.tierColor = TIER_COLORS[solo.tier.toLowerCase()] ?? '#c89b3c';

    const recent = this.matches
      .filter(m => m.info.queueId === 420)
      .sort((a, b) => a.info.gameCreation - b.info.gameCreation);

    if (recent.length < 2) { this.lpPoints = []; return; }

    let lp = solo.leaguePoints;
    const raw: typeof this.allRaw = [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const me = recent[i].info.participants.find(p => p.puuid === this.puuid);
      if (!me) continue;
      raw.unshift({
        lp, date: new Date(recent[i].info.gameCreation),
        win: me.win, champion: me.championName,
        kills: me.kills, deaths: me.deaths, assists: me.assists,
        role: me.teamPosition || '',
      });
      lp -= me.win ? AVG_WIN : AVG_LOSS;
    }
    raw.unshift({ lp, date: new Date(recent[0].info.gameCreation), win: false, champion: '', kills: 0, deaths: 0, assists: 0, role: '' });

    this.allRaw    = raw;
    this.chartPage = 0;
    this.renderPage();
  }

  private renderPage(): void {
    const solo = this.ranked.find(r => r.queueType === 'RANKED_SOLO_5x5');
    if (!solo || !this.allRaw.length) { this.lpPoints = []; return; }

    const endIdx   = this.allRaw.length - this.chartPage * 20;
    const startIdx = Math.max(0, endIdx - 21);
    const raw = this.allRaw.slice(startIdx, endIdx);

    const vals  = raw.map(p => p.lp);
    this.lpMin  = Math.min(...vals);
    this.lpMax  = Math.max(...vals);
    const range = (this.lpMax - this.lpMin) || 1;

    // 8% padding top and bottom so points don't hug the chart edges
    const displayMin = this.lpMin - range * 0.08;
    const displayMax = this.lpMax + range * 0.08;
    const displayRange = displayMax - displayMin;

    const W  = this.CW - this.PAD * 2;
    const H  = this.CH - this.PAD * 2;
    const toX = (i: number) => this.PAD + (i / Math.max(raw.length - 1, 1)) * W;
    const toY = (v: number) => this.PAD + (1 - (v - displayMin) / displayRange) * H;

    const baseAbs  = absLPfrom(solo.tier, solo.rank);
    const lpOffset = solo.leaguePoints;
    this.tierZones = [];
    const loMult = Math.floor(displayMin / 100) * 100;
    const hiMult = Math.ceil(displayMax / 100) * 100;
    for (let v = loMult; v < hiMult; v += 100) {
      const zY1 = Math.min(toY(v), toY(v + 100));
      const zY2 = Math.max(toY(v), toY(v + 100));
      const absLP = baseAbs + (v + 50 - lpOffset);
      this.tierZones.push({ y1: zY1, y2: zY2, color: colorFromAbs(absLP) });
    }

    const pts: string[] = [];
    const fillPts: string[] = [];
    this.deltaLabels = [];

    pts.push(`${toX(0).toFixed(1)},${toY(raw[0].lp).toFixed(1)}`);
    fillPts.push(`${toX(0).toFixed(1)},${(this.CH - this.PAD + 2).toFixed(1)}`);
    fillPts.push(`${toX(0).toFixed(1)},${toY(raw[0].lp).toFixed(1)}`);

    for (let i = 1; i < raw.length; i++) {
      const x     = parseFloat(toX(i).toFixed(1));
      const prevY = parseFloat(toY(raw[i - 1].lp).toFixed(1));
      const currY = parseFloat(toY(raw[i].lp).toFixed(1));
      const delta = Math.round(raw[i].lp - raw[i - 1].lp);
      pts.push(`${x},${prevY}`);
      pts.push(`${x},${currY}`);
      fillPts.push(`${x},${prevY}`);
      fillPts.push(`${x},${currY}`);
      this.deltaLabels.push({ x, yMid: (prevY + currY) / 2, yTop: Math.min(prevY, currY), yBot: Math.max(prevY, currY), delta, win: raw[i].win });
    }
    const lastX = toX(raw.length - 1).toFixed(1);
    fillPts.push(`${lastX},${(this.CH - this.PAD + 2).toFixed(1)}`);

    this.stepPolyline = pts.join(' ');
    this.fillPolygon  = fillPts.join(' ');

    this.lpPoints = raw.map((p, i) => ({
      idx: i, lp: p.lp, date: p.date, win: p.win,
      delta: i === 0 ? 0 : Math.round(p.lp - raw[i - 1].lp),
      champion: p.champion, kills: p.kills, deaths: p.deaths, assists: p.assists, role: p.role,
    }));

    const playedPts = this.lpPoints.slice(1);
    this.peakIdx   = playedPts.reduce((best, pt) => pt.lp > playedPts[best].lp ? pt.idx - 1 : best, 0);
    this.troughIdx = playedPts.reduce((best, pt) => pt.lp < playedPts[best].lp ? pt.idx - 1 : best, 0);
    this.peakY     = parseFloat(toY(this.lpPoints[this.peakIdx + 1]?.lp ?? 0).toFixed(1));
    this.troughY   = parseFloat(toY(this.lpPoints[this.troughIdx + 1]?.lp ?? 0).toFixed(1));

    this.periodWins   = raw.slice(1).filter(p => p.win).length;
    this.periodLosses = raw.slice(1).filter(p => !p.win).length;
    this.netLp        = raw[raw.length - 1].lp - raw[0].lp;
    this.trendDir     = this.netLp > 5 ? 'up' : this.netLp < -5 ? 'down' : 'flat';

    this.divisionLines = [];
    for (let v = loMult; v <= hiMult; v += 100) {
      const absLP = baseAbs + (v - lpOffset);
      if (v >= displayMin && v <= displayMax) {
        this.divisionLines.push({
          y:     parseFloat(toY(v).toFixed(1)),
          label: labelFromAbs(absLP),
          color: colorFromAbs(absLP),
          absLp: v,
        });
      }
    }

    const d0 = raw[0].date;
    const d1 = raw[raw.length - 1].date;
    const fmt = (d: Date) => d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short' });
    this.dateRangeLabel = `${fmt(d0)} — ${fmt(d1)}`;
  }

  getLpX(i: number): number {
    const W = this.CW - this.PAD * 2;
    return this.PAD + (i / Math.max(this.lpPoints.length - 1, 1)) * W;
  }
  getLpY(lp: number): number {
    const vals = this.lpPoints.map(p => p.lp);
    const mn = Math.min(...vals), mx = Math.max(...vals);
    const rng = (mx - mn) || 1;
    const dMin = mn - rng * 0.08, dMax = mx + rng * 0.08, dRng = dMax - dMin;
    return this.PAD + (1 - (lp - dMin) / dRng) * (this.CH - this.PAD * 2);
  }

  getStripX(i: number): number {
    const games = this.lpPoints.length - 1;
    return games > 0 ? ((i - 1) / games) * this.SW : 0;
  }
  getStripW(): number {
    const games = this.lpPoints.length - 1;
    return games > 0 ? Math.max(this.SW / games - 1.5, 2) : 4;
  }

  onStepHover(dl: DeltaLabel, i: number): void {
    const pt = this.lpPoints[i + 1];
    if (pt) {
      this.hoveredPt = pt;
      this.hoverX = dl.x;
      this.hoverY = dl.yTop - 8;
    }
  }
  clearHover(): void { this.hoveredPt = null; }

  formatDate(d: Date): string {
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  netLpStr(): string { return (this.netLp >= 0 ? '+' : '') + this.netLp + ' LP'; }

  get trendArrow(): string {
    return this.trendDir === 'up' ? '↑' : this.trendDir === 'down' ? '↓' : '→';
  }
  get trendClass(): string {
    return this.trendDir === 'up' ? 'trend-up' : this.trendDir === 'down' ? 'trend-down' : 'trend-flat';
  }
}
