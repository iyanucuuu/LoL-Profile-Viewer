import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MasteryEntry, RiotApiService } from '../../services/riot-api';

@Component({
  selector: 'app-champion-mastery',
  imports: [CommonModule],
  templateUrl: './champion-mastery.html',
  styleUrl: './champion-mastery.css'
})
export class ChampionMastery {
  @Input() mastery: MasteryEntry[] = [];
  displayLimit = 10;

  constructor(public riotApi: RiotApiService) {}

  get visibleMastery(): MasteryEntry[] { return this.mastery.slice(0, this.displayLimit); }
  get hasMore(): boolean { return this.displayLimit < this.mastery.length; }
  showMore(): void { this.displayLimit += 10; }
  showLess(): void { this.displayLimit = Math.max(10, this.displayLimit - 10); }

  formatPoints(points: number): string {
    if (points >= 1000000) return (points / 1000000).toFixed(1) + 'M';
    if (points >= 1000) return (points / 1000).toFixed(0) + 'K';
    return points.toString();
  }

  levelColor(level: number): string {
    if (level >= 21) return '#f4c874';
    if (level >= 15) return '#c8aa6e';
    if (level >= 10) return '#e84848';
    if (level >= 7)  return '#9d48e8';
    if (level >= 5)  return '#57bf5e';
    return '#5a6a7a';
  }

  // r=18, circumference = 2π×18 ≈ 113.1
  readonly RING_C = 2 * Math.PI * 18;

  getProgress(champ: MasteryEntry): number {
    const until = champ.championPointsUntilNextLevel ?? 0;
    if (until === 0) return 1;
    const since = champ.championPointsSinceLastLevel ?? 0;
    return Math.min(since / (since + until), 1);
  }

  ringOffset(champ: MasteryEntry): number {
    return this.RING_C * (1 - this.getProgress(champ));
  }
}
