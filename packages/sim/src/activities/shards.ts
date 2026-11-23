import type { World } from '../world';
import type { ShardsConfig } from './config';
import type { ShardSite } from './placement';
import type { ActivityProgress } from './progress';

/**
 * Hidden data shards: collectables tucked round the city, picked up by walking
 * or driving through them. Each pays a little; every `milestone` found pays a
 * lump sum. Found shards stay found (the save keeps their ids).
 */
export class ShardSystem {
  /** Parallel to `sites`: found already. */
  readonly found: boolean[];
  private foundCount = 0;

  constructor(
    private readonly world: World,
    private readonly config: ShardsConfig,
    readonly sites: readonly ShardSite[],
    private readonly progress: () => ActivityProgress,
  ) {
    this.found = sites.map(() => false);
    this.sync();
  }

  get count(): number {
    return this.foundCount;
  }

  get total(): number {
    return this.sites.length;
  }

  /** Re-read the found list from progress (after a load). */
  sync(): void {
    const ids = new Set(this.progress().shards);
    this.foundCount = 0;
    this.sites.forEach((s, i) => {
      this.found[i] = ids.has(s.id);
      if (this.found[i]) this.foundCount++;
    });
  }

  step(): void {
    const w = this.world;
    const pc = w.playerCtl;
    if (pc.dead || pc.busted) return;
    const r = this.config.radius + (w.player.vehicle ? 1.2 : 0);
    const px = w.player.x;
    const pz = w.player.z;
    for (let i = 0; i < this.sites.length; i++) {
      if (this.found[i]) continue;
      const s = this.sites[i]!;
      if (Math.abs(s.x - px) > r || Math.abs(s.z - pz) > r || Math.hypot(s.x - px, s.z - pz) > r) continue;
      this.found[i] = true;
      this.foundCount++;
      const p = this.progress();
      if (!p.shards.includes(s.id)) p.shards.push(s.id);
      const c = this.config;
      const milestone = this.foundCount % c.milestone === 0 ? c.milestoneReward : 0;
      const reward = c.reward + milestone;
      w.score.credits += reward;
      w.events.push({ type: 'shardFound', id: s.id, found: this.foundCount, total: this.sites.length, reward, milestone, x: s.x, z: s.z });
    }
  }
}
