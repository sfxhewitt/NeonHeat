import type { World } from '../world';
import type { Actor } from '../actors';
import type { ActivitiesConfig, RampageDef } from './config';
import type { TokenSite } from './placement';
import type { ActivityProgress } from './progress';

export interface RampageToken {
  def: RampageDef;
  site: TokenSite;
  /** Seconds before the token can be touched again. */
  cooldown: number;
}

export interface RampageRun {
  def: RampageDef;
  token: RampageToken;
  phase: 'ready' | 'run';
  /** Seconds left: of the countdown while ready, of the challenge while running. */
  timeLeft: number;
  elapsed: number;
  count: number;
  /** Takedown: the gang this run spawned. */
  gang: Actor[];
}

/**
 * Rampage tokens: touch one (on foot or in a car) and a timed challenge starts
 * from its JSON: wreck cars, flatten street furniture or put down a gang that
 * comes looking for you. Never "kill civilians": the targets are property and
 * hostile crews. A weapon can come with the token. Pass inside the time to get
 * paid; the token can be replayed for a smaller purse.
 */
export class RampageSystem {
  readonly tokens: RampageToken[];
  run: RampageRun | null = null;

  constructor(
    private readonly world: World,
    private readonly config: ActivitiesConfig['rampages'],
    sites: readonly TokenSite[],
    private readonly progress: () => ActivityProgress,
  ) {
    this.tokens = config.defs.map((def) => ({ def, site: sites.find((s) => s.id === def.id)!, cooldown: 0 })).filter((t) => !!t.site);
  }

  /** Free roam: touching a token starts it. Returns true when one started. */
  tryStart(): boolean {
    const w = this.world;
    const r = this.config.radius + (w.player.vehicle ? 1.2 : 0);
    for (const t of this.tokens) {
      if (t.cooldown > 0) continue;
      if (Math.abs(t.site.x - w.player.x) > r || Math.abs(t.site.z - w.player.z) > r) continue;
      if (Math.hypot(t.site.x - w.player.x, t.site.z - w.player.z) > r) continue;
      this.start(t);
      return true;
    }
    return false;
  }

  start(t: RampageToken): void {
    const w = this.world;
    const def = t.def;
    this.run = { def, token: t, phase: 'ready', timeLeft: this.config.readySec, elapsed: 0, count: 0, gang: [] };
    if (def.weapon) {
      w.combat.give(def.weapon, def.ammo);
      w.combat.equip(def.weapon);
    }
    if (def.kind === 'takedown' && def.gang) this.spawnGang(def);
    this.emit('ready', 0, false);
  }

  private spawnGang(def: RampageDef): void {
    const w = this.world;
    const g = def.gang!;
    const run = this.run!;
    const { x, z } = run.token.site;
    for (let i = 0; i < def.target && run.gang.length < def.target; i++) {
      // Spread round the token, on open ground (pavement, park or yard).
      for (let tries = 0; tries < 24; tries++) {
        const a = w.rng.range(0, Math.PI * 2);
        const d = w.rng.range(g.ring[0], g.ring[1]);
        const px = x + Math.sin(a) * d;
        const pz = z + Math.cos(a) * d;
        if (w.insideBuilding(px, pz, 1) || w.roads.onRoad(px, pz)) continue;
        const actor = w.actors.spawnActor({ x: px, z: pz, faction: g.faction, hostile: true, armed: g.armed, behaviour: 'guard', hp: g.hp, group: `rampage_${def.id}` });
        if (actor) run.gang.push(actor);
        break;
      }
    }
  }

  private emit(phase: 'ready' | 'go' | 'progress' | 'passed' | 'failed' | 'cancelled', reward: number, first: boolean): void {
    const run = this.run!;
    this.world.events.push({ type: 'rampage', id: run.def.id, phase, count: run.count, target: run.def.target, reward, first, seconds: run.elapsed });
  }

  /** End without a result (a job started). */
  cancel(): void {
    if (!this.run) return;
    this.emit('cancelled', 0, false);
    this.finish(false);
  }

  private finish(passed: boolean): void {
    const run = this.run!;
    for (const a of run.gang) if (a.active && !a.dead) this.world.actors.despawnActor(a);
    run.token.cooldown = passed ? this.config.cooldownSec * 4 : this.config.cooldownSec;
    this.run = null;
  }

  step(dt: number): void {
    for (const t of this.tokens) if (t.cooldown > 0) t.cooldown = Math.max(0, t.cooldown - dt);
    const run = this.run;
    if (!run) return;
    const w = this.world;
    if (w.playerCtl.dead || w.playerCtl.busted) {
      this.emit('failed', 0, false);
      this.finish(false);
      return;
    }
    if (run.phase === 'ready') {
      run.timeLeft -= dt;
      if (run.timeLeft <= 0) {
        run.phase = 'run';
        run.timeLeft = run.def.timeSec;
        if (run.def.kind === 'takedown') for (const a of run.gang) w.actors.setAggro(a, true);
        this.emit('go', 0, false);
      }
      return;
    }
    run.elapsed += dt;
    run.timeLeft -= dt;
    const before = run.count;
    const def = run.def;
    if (def.kind === 'wreck') {
      const pv = w.player.vehicle;
      for (const e of w.events) {
        if (e.type !== 'vehicleDestroyed' || e.vehicleId === pv?.id) continue;
        if (w.distToPlayer(e.x, e.z) <= this.config.countRange) run.count++;
      }
    } else if (def.kind === 'smash') {
      for (const e of w.events) if (e.type === 'propBroken' && e.byPlayer) run.count++;
    } else {
      let down = 0;
      for (const a of run.gang) if (a.dead) down++;
      run.count = down;
    }
    if (run.count !== before) this.emit('progress', 0, false);
    if (run.count >= def.target) {
      const p = this.progress();
      const rec = (p.rampages[def.id] ??= { passes: 0, bestSec: 0 });
      const first = rec.passes === 0;
      rec.passes++;
      rec.bestSec = rec.bestSec > 0 ? Math.min(rec.bestSec, Math.round(run.elapsed * 10) / 10) : Math.round(run.elapsed * 10) / 10;
      const reward = first ? def.reward : def.repeatReward;
      w.score.credits += reward;
      this.emit('passed', reward, first);
      this.finish(true);
    } else if (run.timeLeft <= 0) {
      run.timeLeft = 0;
      this.emit('failed', 0, false);
      this.finish(false);
    }
  }
}
