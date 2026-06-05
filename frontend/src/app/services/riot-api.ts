import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface SummonerProfile {
  account:   { puuid: string; gameName: string; tagLine: string };
  summoner:  { profileIconId: number; summonerLevel: number };
  ranked:    RankedEntry[];
  mastery:   MasteryEntry[];
  ddVersion: string;
}

export interface RankedEntry {
  queueType:    string;
  tier:         string;
  rank:         string;
  leaguePoints: number;
  wins:         number;
  losses:       number;
  veteran?:     boolean;
  hotStreak?:   boolean;
}

export interface MasteryEntry {
  championId:                    number;
  championLevel:                 number;
  championPoints:                number;
  championName?:                 string;
  championPointsSinceLastLevel?: number;
  championPointsUntilNextLevel?: number;
  tokensEarned?:                 number;
}

export interface ItemEvent {
  type:   'ITEM_PURCHASED' | 'ITEM_SOLD' | 'ITEM_UNDO';
  itemId: number;
  ts:     number;
}

export interface Match {
  metadata: { matchId: string };
  info: {
    gameDuration:  number;
    gameCreation:  number;
    gameMode:      string;
    queueId:       number;   // 420=Solo, 440=Flex, 450=ARAM
    participants:  Participant[];
  };
}

export interface RuneSelection { perk: number; }
export interface RuneStyle {
  description: 'primaryStyle' | 'subStyle';
  style:       number;
  selections:  RuneSelection[];
}
export interface Perks {
  statPerks: { offense: number; flex: number; defense: number };
  styles:    RuneStyle[];
}

export interface Participant {
  puuid:                          string;
  summonerName:                   string;
  riotIdGameName:                 string;
  championName:                   string;
  teamId:                         number;
  teamPosition:                   string;
  kills:                          number;
  deaths:                         number;
  assists:                        number;
  win:                            boolean;
  totalMinionsKilled:             number;
  neutralMinionsKilled:           number;
  goldEarned:                     number;
  visionScore:                    number;
  totalDamageDealtToChampions:    number;
  item0: number; item1: number; item2: number;
  item3: number; item4: number; item5: number; item6: number;
  summoner1Id:                    number;
  summoner2Id:                    number;
  perks?:                         Perks | null;
}

export interface ChampionStat {
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

@Injectable({ providedIn: 'root' })
export class RiotApiService {
  private base = 'http://localhost:3000/api';
  ddVersion = '15.10.1';

  constructor(private http: HttpClient) {}

  setDdVersion(v: string) {
    this.ddVersion   = v;
    this.itemsLoaded = false;
    this.runesLoaded = false;
    this.loadItemsData();
    this.loadRunesData();
  }

  getSummoner(gameName: string, tagLine: string): Observable<SummonerProfile> {
    return this.http.get<SummonerProfile>(
      `${this.base}/summoner/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`
    );
  }

  getMatches(puuid: string, count = 10, start = 0): Observable<Match[]> {
    return this.http.get<Match[]>(
      `${this.base}/matches/${puuid}?count=${count}&start=${start}`
    );
  }

  getProfileIconUrl(iconId: number): string {
    return `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/img/profileicon/${iconId}.png`;
  }

  getChampionIconUrl(name: string): string {
    if (!name) return '';
    return `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/img/champion/${name}.png`;
  }

  getItemIconUrl(itemId: number): string {
    if (!itemId) return '';
    return `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/img/item/${itemId}.png`;
  }

  getRankedEmblemUrl(tier: string): string {
    const t = tier.toLowerCase();
    return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/ranked-emblem/emblem-${t}.png`;
  }

  getRankedMiniUrl(tier: string): string {
    const t = tier.toLowerCase();
    return `https://raw.communitydragon.org/latest/plugins/rcp-fe-lol-shared-components/global/default/ranked-mini-crests/${t}.png`;
  }

  private readonly SPELL_NAMES: Record<number, string> = {
    1:  'SummonerBoost',
    3:  'SummonerExhaust',
    4:  'SummonerFlash',
    6:  'SummonerHaste',
    7:  'SummonerHeal',
    11: 'SummonerSmite',
    12: 'SummonerTeleport',
    13: 'SummonerMana',
    14: 'SummonerDot',
    21: 'SummonerBarrier',
    32: 'SummonerSnowball',
  };

  readonly SPELL_LABELS: Partial<Record<number, string>> = {
    1:  'Purificar',
    3:  'Agotar',
    4:  'Flash',
    6:  'Fantasma',
    7:  'Curar',
    11: 'Castigar',
    12: 'Teleporte',
    13: 'Claridad',
    14: 'Incendiar',
    21: 'Barrera',
    32: 'Marca',
  };

  private ALWAYS_EXCLUDE_ITEMS = new Set<number>([
    1054, 1055, 1056,
    1082, 1083,
    2010, 2009,
    2403,
    3340, 3363, 3364, 3330,
    2138, 2139, 2140,
    2055, 2056, 2057, 2058,
    3400,
  ]);

  private componentItemIds = new Set<number>();
  private itemsLoaded = false;
  private itemDetails  = new Map<number, { name: string; gold: number; stats: string }>();

  loadItemsData(): void {
    if (this.itemsLoaded) return;
    this.itemsLoaded = true;
    const url = `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/data/en_US/item.json`;
    this.http.get<{ data: Record<string, { into?: string[]; tags?: string[]; name: string; gold?: { total?: number }; stats?: Record<string,number> }> }>(url).subscribe({
      next: (res) => {
        this.componentItemIds.clear();
        this.itemDetails.clear();
        for (const [id, item] of Object.entries(res.data)) {
          const numId = Number(id);
          if (item.into && item.into.length > 0) {
            this.componentItemIds.add(numId);
          }
          if (item.tags?.includes('Starter')) {
            this.ALWAYS_EXCLUDE_ITEMS.add(numId);
          }
          if (item.tags?.includes('Trinket')) {
            this.ALWAYS_EXCLUDE_ITEMS.add(numId);
          }
          if (item.tags?.includes('Consumable')) {
            this.ALWAYS_EXCLUDE_ITEMS.add(numId);
          }
          const itemAny = item as any;
          if (itemAny.inStore === false) {
            this.ALWAYS_EXCLUDE_ITEMS.add(numId);
          }
          if (itemAny.maps && itemAny.maps['11'] === false) {
            this.ALWAYS_EXCLUDE_ITEMS.add(numId);
          }
          if (!item.gold?.total || item.gold.total === 0) {
            this.ALWAYS_EXCLUDE_ITEMS.add(numId);
          }
          const n = (item.name ?? '').toLowerCase();
          if (n.includes('preferencia') || n.includes('preference') ||
              n.includes('placeholder') || n.includes('gustito') ||
              n.includes("doran")) {
            this.ALWAYS_EXCLUDE_ITEMS.add(numId);
          }
          const statParts: string[] = [];
          if (item.stats) {
            const labels: Record<string, string> = {
              FlatPhysicalDamageMod: 'DA', FlatMagicDamageMod: 'PA',
              FlatArmorMod: 'Armadura', FlatSpellBlockMod: 'RM',
              FlatHPPoolMod: 'Vida', FlatMPPoolMod: 'Maná',
              FlatCritChanceMod: 'CC%', PercentAttackSpeedMod: 'VA',
              FlatMovementSpeedMod: 'VdM',
            };
            for (const [k, v] of Object.entries(item.stats)) {
              const label = labels[k];
              if (label) {
                const val = k === 'FlatCritChanceMod' ? `${Math.round(v * 100)}%`
                           : k === 'PercentAttackSpeedMod' ? `${Math.round(v * 100)}%`
                           : `${Math.round(v)}`;
                statParts.push(`+${val} ${label}`);
              }
            }
          }
          this.itemDetails.set(numId, {
            name:  item.name,
            gold:  item.gold?.total ?? 0,
            stats: statParts.join(' · '),
          });
        }
      },
      error: () => {}
    });
  }

  isCompleteItem(id: number): boolean {
    if (!id) return false;
    if (this.ALWAYS_EXCLUDE_ITEMS.has(id)) return false;
    return !this.componentItemIds.has(id);
  }

  getItemDetail(id: number): { name: string; gold: number; stats: string } | null {
    return this.itemDetails.get(id) ?? null;
  }

  getTimeline(matchId: string, puuid: string): Observable<{ events: ItemEvent[]; cached: boolean }> {
    return this.http.get<{ events: ItemEvent[]; cached: boolean }>(
      `${this.base}/timeline/${matchId}?puuid=${encodeURIComponent(puuid)}`
    );
  }

  getTimelinesBatch(matchIds: string[], puuid: string): Observable<Map<string, ItemEvent[]>> {
    return this.http.post<{ timelines: { match_id: string; events: ItemEvent[] }[] }>(
      `${this.base}/timelines/batch`, { matchIds, puuid }
    ).pipe(
      map(r => {
        const m = new Map<string, ItemEvent[]>();
        for (const t of r.timelines) m.set(t.match_id, t.events);
        return m;
      })
    );
  }

  getSpellIconUrl(id: number): string {
    const name = this.SPELL_NAMES[id] ?? 'SummonerFlash';
    return `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/img/spell/${name}.png`;
  }

  private runeMap   = new Map<number, { name: string; icon: string }>();
  private runesLoaded = false;
  runePaths: any[]  = [];

  loadRunesData(): void {
    if (this.runesLoaded) return;
    this.runesLoaded = true;
    const url = `https://ddragon.leagueoflegends.com/cdn/${this.ddVersion}/data/en_US/runesReforged.json`;
    this.http.get<any[]>(url).subscribe({
      next: (paths) => {
        this.runePaths = paths;
        this.runeMap.clear();
        for (const path of paths) {
          this.runeMap.set(path.id, { name: path.name, icon: path.icon });
          for (const slot of path.slots) {
            for (const rune of slot.runes) {
              this.runeMap.set(rune.id, { name: rune.name, icon: rune.icon });
            }
          }
        }
      },
      error: () => {}
    });
  }

  readonly STAT_SHARDS: { id: number; label: string }[][] = [
    [ { id: 5008, label: 'DA adaptativa' }, { id: 5005, label: 'Vel. ataque' },     { id: 5007, label: 'Prisa hab.' } ],
    [ { id: 5008, label: 'DA adaptativa' }, { id: 5002, label: 'Vida extra' },       { id: 5003, label: 'Escudo mágico' } ],
    [ { id: 5001, label: 'Vida 10-18' },    { id: 5002, label: 'Vida extra' },       { id: 5003, label: 'Escudo mágico' } ],
  ];

  getRuneIconUrl(id: number): string {
    const r = this.runeMap.get(id);
    if (!r) return '';
    return `https://ddragon.leagueoflegends.com/cdn/img/${r.icon}`;
  }

  getRuneName(id: number): string {
    return this.runeMap.get(id)?.name ?? '';
  }

  getOpggBuild(championName: string, position?: string): Observable<any> {
    const pos = (position || 'adc').toLowerCase();
    return this.http.get<any>(`${this.base}/meta/${encodeURIComponent(championName)}/${pos}`);
  }

  getItemMatchup(puuid: string, championName: string, itemId: number): Observable<any> {
    return this.http.post<any>(`${this.base}/analytics/item-matchup`, { puuid, championName, itemId });
  }

  triggerUpdatePerks(puuid: string): Observable<{ type: string; done?: number; total?: number }> {
    return new Observable(obs => {
      const es = new EventSource(
        `${this.base}/matches/update-perks/${encodeURIComponent(puuid)}`
      );
      es.onmessage = ev => {
        try { obs.next(JSON.parse(ev.data)); } catch {}
      };
      es.addEventListener('done', () => {
        es.close();
        obs.complete();
      });
      es.addEventListener('error', (ev: any) => {
        es.close();
        if (es.readyState === EventSource.CLOSED) obs.complete();
        else obs.error(ev);
      });
      return () => es.close();
    });
  }

  getTierColor(tier: string): string {
    const colors: Record<string,string> = {
      iron:'#8b8989', bronze:'#ae6c3d', silver:'#a1a5ba',
      gold:'#c89b3c', platinum:'#1e9c8c', emerald:'#57bf5e',
      diamond:'#7677ce', master:'#9d48e8', grandmaster:'#e84848',
      challenger:'#f4c874'
    };
    return colors[tier.toLowerCase()] ?? '#c8aa6e';
  }
}
