import { driveTowards, emptyControls, emptyIntents, forwardSpeed, type Intents, type Vehicle, type World } from '@neonheat/sim';
import type { MissionDirector } from './director';

/**
 * A headless test bot that plays missions through the same intent layer as a
 * player: walks, steals cars, drives the road graph, hacks and delivers.
 * Used by CI to prove a mission can be completed, and by the soak test.
 */
export class MissionBot {
  /** Which mission to pick up when idle. */
  missionId: string;
  private readonly ctl = emptyControls();
  private waypoint = -1;
  private stuckTime = 0;
  private reverseTime = 0;
  private reverseSteer = 1;
  private interactCooldown = 0;
  private hackDelay = 0;
  cruiseSpeed = 22;

  constructor(
    private readonly world: World,
    private readonly director: MissionDirector,
  ) {
    this.missionId = director.missions[0]?.id ?? '';
  }

  next(dt: number): Intents {
    const out = emptyIntents();
    const w = this.world;
    const pc = w.playerCtl;
    const d = this.director;
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);
    if (pc.dead) return out;

    // Hack minigame: wait for the input phase, then tap the sequence with a human-ish delay.
    if (d.hack) {
      if (d.hack.phase === 'input') {
        this.hackDelay -= dt;
        if (this.hackDelay <= 0) {
          d.hackTap(d.hack.sequence[d.hack.inputIndex]!);
          this.hackDelay = 0.25;
        }
      }
      return out;
    }

    const r = d.runner;
    if (r && r.state === 'failed') return out; // the director retries
    let goalX: number;
    let goalZ: number;
    /** Need to stand here on foot and press the context button for this. */
    let footAction: ((kind: string, vehicleId: number, interactable: string) => boolean) | null = null;
    let targetVehicle = -1;

    if (!r || r.state !== 'running') {
      const m = d.missions.find((x) => x.id === this.missionId);
      if (!m) return out;
      goalX = m.giver.pos[0];
      goalZ = m.giver.pos[2];
      footAction = (kind, _v, it) => kind === 'interact' && it === `giver:${m.id}`;
    } else {
      const v = r.view;
      goalX = v.targetX;
      goalZ = v.targetZ;
      const o = r.objective!;
      if (o.type === 'hack') {
        targetVehicle = v.vehicleId;
        footAction = (kind, vid) => kind === 'hack' && vid === targetVehicle;
      } else if (o.type === 'deliverVehicle' && w.player.vehicle?.id !== v.vehicleId) {
        targetVehicle = v.vehicleId;
        footAction = (kind, vid) => (kind === 'enter' || kind === 'steal') && vid === targetVehicle;
        // Out of somebody else's car first.
        if (w.player.vehicle) footAction = footAction ?? null;
      }
    }

    const px = w.player.x;
    const pz = w.player.z;
    const dist = Math.hypot(goalX - px, goalZ - pz);

    if (footAction) {
      if (pc.mode === 'driving') {
        if (dist < 12) {
          this.stop(out);
          if (Math.abs(w.playerSpeed()) < 3) this.press(out, pc.context?.kind === 'exit');
        } else {
          this.drive(goalX, goalZ, dist, out, 6);
        }
        return out;
      }
      const c = pc.context;
      if (c && footAction(c.kind, c.vehicleId, c.interactableId)) {
        this.press(out, true);
        return out;
      }
      if (dist > 45 && this.goForCar(out, targetVehicle)) return out;
      this.walk(goalX, goalZ, out, targetVehicle >= 0 ? 1.5 : 0.8);
      return out;
    }

    // A driving objective.
    if (pc.mode === 'foot') {
      if (dist > 25 && this.goForCar(out, -1)) return out;
      this.walk(goalX, goalZ, out, 0);
      return out;
    }
    this.drive(goalX, goalZ, dist, out, 0);
    return out;
  }

  private press(out: Intents, ok: boolean): void {
    if (!ok || this.interactCooldown > 0) return;
    out.interact = true;
    this.interactCooldown = 0.6;
  }

  private stop(out: Intents): void {
    const v = this.world.player.vehicle;
    out.scheme = 'classic';
    out.brake = v && forwardSpeed(v) > 0.5 ? 1 : 0;
  }

  /** Walk to the nearest usable car and get in. Returns false if none is close. */
  private goForCar(out: Intents, exclude: number): boolean {
    const w = this.world;
    const pc = w.playerCtl;
    let best: Vehicle | null = null;
    let bd = 28;
    for (const v of w.vehicles) {
      if (!v.active || v.destroyed || v.locked || v.hackable || v.id === exclude) continue;
      if (v.role !== 'parked' && v.role !== 'traffic') continue;
      const d = Math.hypot(v.x - pc.x, v.z - pc.z);
      if (d < bd) {
        bd = d;
        best = v;
      }
    }
    if (!best) return false;
    const c = pc.context;
    if (c && (c.kind === 'enter' || c.kind === 'steal') && c.vehicleId === best.id) {
      this.press(out, true);
      return true;
    }
    this.walk(best.x, best.z, out, 0);
    return true;
  }

  private walk(tx: number, tz: number, out: Intents, stopAt: number): void {
    const w = this.world;
    const pc = w.playerCtl;
    let gx = tx;
    let gz = tz;
    if (!w.police.lineOfSight(pc.x, pc.z, tx, tz)) {
      const p = this.routePoint(pc.x, pc.z, tx, tz);
      gx = p.x;
      gz = p.z;
    } else this.waypoint = -1;
    const dx = gx - pc.x;
    const dz = gz - pc.z;
    const len = Math.hypot(dx, dz);
    if (len < stopAt) return;
    out.moveX = dx / (len || 1);
    out.moveY = -dz / (len || 1);
  }

  private readonly tmp = { x: 0, z: 0 };

  /** Next road-graph point towards (tx, tz) from (x, z). */
  private routePoint(x: number, z: number, tx: number, tz: number): { x: number; z: number } {
    const g = this.world.roads;
    if (this.waypoint < 0 || Math.hypot(g.nodes[this.waypoint]!.x - x, g.nodes[this.waypoint]!.z - z) > 450) {
      this.waypoint = g.nearest(x, z).id;
    }
    const wp = g.nodes[this.waypoint]!;
    if (Math.hypot(wp.x - x, wp.z - z) < 6) this.waypoint = g.nextHop(wp.id, g.nearest(tx, tz).id);
    const n = g.nodes[this.waypoint]!;
    this.tmp.x = n.x;
    this.tmp.z = n.z;
    return this.tmp;
  }

  private drive(tx: number, tz: number, dist: number, out: Intents, arriveSpeed: number): void {
    const w = this.world;
    const v = w.player.vehicle!;
    const dt = 1 / 60;
    let gx = tx;
    let gz = tz;
    let speed = Math.min(this.cruiseSpeed, arriveSpeed + dist * 0.45);
    if (!(dist < 80 && w.police.lineOfSight(v.x, v.z, tx, tz))) {
      const p = this.routePoint(v.x, v.z, tx, tz);
      gx = p.x;
      gz = p.z;
      const wd = Math.hypot(gx - v.x, gz - v.z);
      speed = Math.min(this.cruiseSpeed, 9 + wd * 0.5);
    } else this.waypoint = -1;
    const c = this.ctl;
    if (this.reverseTime > 0) {
      this.reverseTime -= dt;
      out.scheme = 'classic';
      out.brake = 1;
      out.steer = this.reverseSteer;
      return;
    }
    driveTowards(v, gx, gz, speed, c, false);
    if (speed > 3 && Math.abs(forwardSpeed(v)) < 1) this.stuckTime += dt;
    else this.stuckTime = Math.max(0, this.stuckTime - dt);
    if (this.stuckTime > 1.2) {
      this.stuckTime = 0;
      this.reverseTime = 1.1;
      this.reverseSteer = c.steer >= 0 ? -1 : 1;
    }
    out.scheme = 'classic';
    out.steer = c.steer;
    out.throttle = c.throttle;
    out.brake = c.brake;
    out.handbrake = c.handbrake;
  }
}
