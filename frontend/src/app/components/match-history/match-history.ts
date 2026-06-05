import { Component, Input, Output, EventEmitter, OnChanges, SimpleChanges } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Match, Participant, RiotApiService } from '../../services/riot-api';

const PAGE_SIZE = 20;

@Component({
  selector: 'app-match-history',
  imports: [CommonModule],
  templateUrl: './match-history.html',
  styleUrl: './match-history.css'
})
export class MatchHistory implements OnChanges {
  @Input() matches:       Match[]  = [];
  @Input() puuid          = '';
  @Input() loadingMatches = false;
  @Input() loadingMore    = false;
  @Input() noMoreMatches  = false;

  @Output() loadMore = new EventEmitter<void>();

  expandedIndex: number | null = null;
  currentPage = 0;   // 0-indexed

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['matches']) {
      const prev = changes['matches'].previousValue as Match[] | undefined;
      const curr = changes['matches'].currentValue as Match[] | undefined;
      if (!prev?.length && curr?.length) {
        this.currentPage   = 0;
        this.expandedIndex = null;
      }
    }
  }

  get totalPages(): number {
    return Math.max(1, Math.ceil(this.matches.length / PAGE_SIZE));
  }

  get pageStart(): number { return this.currentPage * PAGE_SIZE; }
  get pageEnd():   number { return Math.min(this.pageStart + PAGE_SIZE, this.matches.length); }

  get visibleMatches(): Match[] {
    return this.matches.slice(this.pageStart, this.pageEnd);
  }

  get hasPrev(): boolean { return this.currentPage > 0; }
  get hasNext(): boolean { return this.currentPage < this.totalPages - 1; }

  prevPage(): void {
    if (this.hasPrev) { this.currentPage--; this.expandedIndex = null; }
  }
  nextPage(): void {
    if (this.hasNext) { this.currentPage++; this.expandedIndex = null; }
  }

  constructor(public riotApi: RiotApiService) {}

  getPlayer(match: Match): Participant | undefined {
    return match.info.participants.find(p => p.puuid === this.puuid);
  }

  getPlayerTeam(match: Match): number {
    return this.getPlayer(match)?.teamId ?? 100;
  }

  private readonly POS_ORDER: Record<string, number> = {
    TOP: 0, JUNGLE: 1, MIDDLE: 2, BOTTOM: 3, UTILITY: 4
  };

  private sortByPos(ps: Participant[]): Participant[] {
    return [...ps].sort((a, b) =>
      (this.POS_ORDER[a.teamPosition ?? ''] ?? 5) - (this.POS_ORDER[b.teamPosition ?? ''] ?? 5)
    );
  }

  getMyTeamSorted(match: Match): Participant[] {
    const myTeam = this.getPlayerTeam(match);
    return this.sortByPos(match.info.participants.filter(p => p.teamId === myTeam));
  }

  getOpponents(match: Match): Participant[] {
    const myTeam = this.getPlayerTeam(match);
    return this.sortByPos(match.info.participants.filter(p => p.teamId !== myTeam));
  }

  getAllies(match: Match): Participant[] {
    const myTeam = this.getPlayerTeam(match);
    return match.info.participants.filter(p => p.teamId === myTeam && p.puuid !== this.puuid);
  }

  getItemDetail(id: number) { return this.riotApi.getItemDetail(id); }

  formatDuration(s: number): string {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${m}m ${sec.toString().padStart(2,'0')}s`;
  }

  getKda(p: Participant): string {
    const deaths = p.deaths || 1;
    return ((p.kills + p.assists) / deaths).toFixed(2);
  }

  getCs(p: Participant): number {
    return (p.totalMinionsKilled || 0) + (p.neutralMinionsKilled || 0);
  }

  getCsPerMin(p: Participant, match: Match): string {
    const cs = this.getCs(p);
    const min = match.info.gameDuration / 60;
    return min > 0 ? (cs / min).toFixed(1) : '0.0';
  }

  getCsTarget(match: Match): string {
    const min = match.info.gameDuration / 60;
    if (min < 10) return '5.0';
    if (min < 20) return '6.5';
    if (min < 30) return '7.5';
    return '8.0';
  }

  getCsClass(p: Participant, match: Match): string {
    const actual = parseFloat(this.getCsPerMin(p, match));
    const target = parseFloat(this.getCsTarget(match));
    if (actual >= target * 0.9) return 'cs-good';
    if (actual >= target * 0.7) return 'cs-ok';
    return 'cs-bad';
  }

  getItems(p: Participant): number[] {
    return [p.item0, p.item1, p.item2, p.item3, p.item4, p.item5, p.item6]
      .filter(i => i > 0 && this.riotApi.isCompleteItem(i));
  }

  getQueueLabel(match: Match): string {
    const labels: Record<number, string> = {
      420:  'Solo/Duo', 440: 'Flex', 450: 'ARAM',
      430:  'Normal',   490: 'Normal Draft',
      900:  'URF',      1020: 'URF', 1900: 'URF',
      1400: 'Definitivo',
      1700: 'Arena',    2000: 'Tutorial',
    };
    const id = match.info.queueId ?? 0;
    if (labels[id]) return labels[id];
    const modeMap: Record<string,string> = {
      CLASSIC: 'Summoner\'s Rift', ARAM: 'ARAM', URF: 'URF', CHERRY: 'Arena'
    };
    return modeMap[match.info.gameMode] ?? match.info.gameMode;
  }

  toggleExpand(i: number) {
    this.expandedIndex = this.expandedIndex === i ? null : i;
  }

  formatGold(n: number): string {
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : `${n}`;
  }

  formatDmg(n: number): string {
    return n >= 1000 ? Math.round(n / 100) / 10 + 'k' : `${n}`;
  }

  private matchDate(match: Match): Date {
    return new Date(match.info.gameCreation);
  }

  isDifferentDay(match: Match, prev: Match | null): boolean {
    if (!prev) return true;
    return this.matchDate(match).toDateString() !== this.matchDate(prev).toDateString();
  }

  getDayLabel(match: Match): string {
    const d   = this.matchDate(match);
    const now = new Date();
    const yest = new Date(now);
    yest.setDate(now.getDate() - 1);
    if (d.toDateString() === now.toDateString())  return 'Hoy';
    if (d.toDateString() === yest.toDateString()) return 'Ayer';
    return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  getMatchTime(match: Match): string {
    return this.matchDate(match).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  }

  getKillParticipation(match: Match): number {
    const p = this.getPlayer(match);
    if (!p) return 0;
    const teamKills = match.info.participants
      .filter(x => x.teamId === p.teamId)
      .reduce((sum, x) => sum + x.kills, 0);
    if (teamKills === 0) return 0;
    return Math.round(((p.kills + p.assists) / teamKills) * 100);
  }

  getPositionLabel(p: Participant): string {
    const map: Record<string, string> = {
      TOP: 'Top', JUNGLE: 'Jg', MIDDLE: 'Mid',
      BOTTOM: 'ADC', UTILITY: 'Sup'
    };
    return map[p.teamPosition ?? ''] ?? '';
  }

  getLaneOpponent(match: Match): Participant | null {
    const p = this.getPlayer(match);
    if (!p || !p.teamPosition) return null;
    return match.info.participants.find(
      x => x.teamId !== p.teamId && x.teamPosition === p.teamPosition
    ) ?? null;
  }
}
