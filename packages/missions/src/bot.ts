import { driveTowards, emptyControls, emptyIntents, forwardSpeed, nearestMain, type Intents, type Vehicle, type World } from '@neonheat/sim';
import type { MissionDirector } from './director';

type Need = 'foot' | 'car' | 'either';

interface Plan {
  x: number;
  z: number;
  need: Need;
  /** On foot: press the context button when it offers this. */
  press?: (kind: string, vehicleId: number, interactable: string) => boolean;
  /** Car the bot must be in (it walks to it and gets in), or -1. */
  car: number;
  /** Driving: speed to arrive at (high = drive through, 0 = stop on it). */
  arrive: number;
  /** On foot: stop this far away. */
  stopAt: number;
  /** On foot: shoot at the goal once in range and in view. */
  shoot?: boolean;
  /** Driving: keep this far behind the goal (tailing). */
  follow?: number;
  /** Tail: back away when nearer than this. */
  backOff?: number;
}

/**
 * A headless test bot that plays missions through the same intent layer as a
 * player: walks, steals cars, drives the road graph, hacks, shoots, races,
 * collects and shakes off HEAT. Used by CI to prove missions can be
 * completed, and by the soak test.
 */
export class MissionBot {
  /** Which mission to pick up when idle. */
  missionId: string;
  private readonly ctl = emptyControls();
  private waypoint = -1;
  private stuckTime = 0;
  /** Seconds the car has barely moved while heading for an on-foot goal. */
  private wedged = 0;
  private wedgeDist = Infinity;
  private walkStuck = 0;
  private shoveTime = 0;
  private walkRoute = 0;
  private walkPath: { x: number; z: number }[] = [];
  private walkGoal = { x: Infinity, z: Infinity };
  private walkReplan = 0;
  private reverseTime = 0;
  private reverseSteer = 1;
  private interactCooldown = 0;
  private hackDelay = 0;
  private fireCooldown = 0;
  private dodgeCooldown = 0;
  private escapeNode = -1;
  cruiseSpeed = 22;

  constructor(
    private readonly world: World,
    private readonly director: MissionDirector,
  ) {
    this.missionId = director.available()[0]?.id ?? director.missions[0]?.id ?? '';
  }

  next(dt: number): Intents {
    const out = emptyIntents();
    const w = this.world;
    const pc = w.playerCtl;
    const d = this.director;
    this.interactCooldown = Math.max(0, this.interactCooldown - dt);
    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    if (pc.incapacitated) return out;

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
    const plan = this.plan(out);
    if (!plan) return out;
    this.execute(plan, out);
    return out;
  }

  /** Work out where to go and what to do there. May write one-shot intents (dodge, fire) itself. */
  private plan(out: Intents): Plan | null {
    const w = this.world;
    const d = this.director;
    const r = d.runner;
    const pc = w.playerCtl;
    const px = w.player.x;
    const pz = w.player.z;
    if (!r || r.state !== 'running') {
      const m = d.missions.find((x) => x.id === this.missionId);
      const g = m ? d.giverPos(m) : null;
      if (!m || !g) return null;
      return { x: g.x, z: g.z, need: Math.hypot(g.x - px, g.z - pz) > 60 ? 'either' : 'foot', car: -1, arrive: 0, stopAt: 0.8, press: (k, _v, it) => k === 'interact' && it === `giver:${m.id}` };
    }
    const v = r.view;
    const o = r.objective!;
    const base: Plan = { x: v.targetX, z: v.targetZ, need: 'either', car: -1, arrive: 0, stopAt: 0.8 };
    // Drive carefully when the car has to arrive in one piece.
    this.cruiseSpeed = o.type === 'deliverVehicle' && o.minHealth > 0 ? 16 : 22;
    switch (o.type) {
      case 'reach':
        if (o.vehicle === 'none') return { ...base, need: 'foot' };
        if (o.vehicle === 'any') return { ...base, need: 'car', arrive: 4 };
        if (o.vehicle) return this.inCar(r.view.vehicleId >= 0 ? r.view.vehicleId : d.host.ensureVehicle(o.vehicle), base, 4);
        return { ...base, arrive: 4 };
      case 'hack':
        if (o.target.startsWith('spawn:')) return { ...base, need: 'foot', stopAt: 1.5, press: (k, vid) => k === 'hack' && vid === v.vehicleId };
        return { ...base, need: 'foot', stopAt: 0.5, press: (k, _v, it) => k === 'interact' && it === `terminal:${o.id}` };
      case 'deliverVehicle':
        return this.inCar(v.vehicleId, base, 3);
      case 'stealVehicle':
        return v.vehicleId >= 0 ? this.inCar(v.vehicleId, base, 0) : { ...base, need: 'foot' };
      case 'destroyVehicle': {
        // A parked target: get out and shoot it (ramming a heavy truck barely scratches it).
        const t = v.vehicleId >= 0 ? w.vehicles[v.vehicleId] : undefined;
        if (t && Math.hypot(t.vx, t.vz) < 3) return { ...base, need: 'foot', stopAt: 9, shoot: true };
        return { ...base, need: 'car', arrive: 30, car: -1 };
      }
      case 'chase':
        // Ram it: arrive flat out.
        return { ...base, need: 'car', arrive: 30, car: -1 };
      case 'eliminate':
        return { ...base, need: 'foot', stopAt: 9, shoot: true };
      case 'protect':
        if (o.durationSec !== undefined) {
          // Guarding someone: on foot beside them, shooting whoever comes for them.
          const h = w.actors.nearestHostile(v.targetX, v.targetZ, 34);
          if (h && h.aggro) return { ...base, x: h.x, z: h.z, need: 'foot', stopAt: 9, shoot: true };
          return { ...base, need: 'foot', stopAt: 4 };
        }
        return { ...base, need: 'car', follow: 18 };
      case 'tail':
        return { ...base, need: 'car', follow: (o.minRange + o.maxRange) / 2, backOff: o.minRange + 4 };
      case 'escape': {
        const g = this.escapePoint(px, pz);
        return { ...base, x: g.x, z: g.z, need: 'car', arrive: 18 };
      }
      case 'race':
        return { ...base, need: 'car', arrive: 18 };
      case 'collect':
        if (o.vehicle === 'none') return { ...base, need: 'foot', stopAt: 0.5 };
        return { ...base, need: o.vehicle === 'any' || o.vehicle?.startsWith('spawn:') ? 'car' : 'either', arrive: 6 };
      case 'wait':
        if (o.vehicle === 'none') return { ...base, need: 'foot', stopAt: 1 };
        return { ...base, need: o.vehicle ? 'car' : 'either', arrive: 0 };
      case 'dropOff':
        return { ...base, need: 'car', arrive: 0 };
      case 'photograph':
        return { ...base, need: 'either', stopAt: o.range * 0.5, arrive: 0 };
      case 'perform':
        if (o.action === 'dodge') {
          if (pc.mode === 'driving') return { ...base, need: 'foot' };
          if (this.dodgeCooldown <= 0) {
            out.dodge = true;
            this.dodgeCooldown = 1.4;
          }
          return null;
        }
        if (o.action === 'fire') {
          if (pc.mode === 'driving') return { ...base, need: 'foot' };
          if (this.fireCooldown <= 0) {
            out.fire = true;
            this.fireCooldown = 0.5;
          }
          return null;
        }
        if (o.action === 'exit') {
          if (pc.mode === 'foot') return null;
          this.stop(out);
          this.press(out, pc.context?.kind === 'exit');
          return null;
        }
        return { ...base, need: 'car', x: px, z: pz };
    }
  }

  /** Be in this particular car, then head for the plan's goal. */
  private inCar(vehicleId: number, base: Plan, arrive: number): Plan {
    const w = this.world;
    if (vehicleId >= 0 && w.player.vehicle?.id === vehicleId) return { ...base, need: 'car', arrive };
    const car = w.vehicles[vehicleId];
    if (!car || !car.active) return { ...base, need: 'foot' };
    return { ...base, x: car.x, z: car.z, need: 'foot', car: vehicleId, stopAt: 1.5, press: (k, vid) => (k === 'enter' || k === 'steal') && vid === vehicleId };
  }

  private execute(p: Plan, out: Intents): void {
    const w = this.world;
    const pc = w.playerCtl;
    const dist = Math.hypot(p.x - w.player.x, p.z - w.player.z);
    const wantFoot = p.need === 'foot' || p.press !== undefined;

    if (pc.mode === 'driving') {
      if (wantFoot) {
        // Drive up near the goal (a far on-foot goal is quicker by car), then stop and get out.
        // Close enough, or wedged on the way: stop, get out and walk the rest.
        // Wedged = not getting any closer over a few seconds (stuck, or circling a point it cannot reach).
        this.wedged += 1 / 60;
        if (dist < this.wedgeDist - 8) {
          this.wedged = 0;
          this.wedgeDist = dist;
        }
        if (dist < 30 || this.wedged > 6) {
          this.stop(out);
          this.press(out, pc.context?.kind === 'exit');
          return;
        }
        this.drive(p.x, p.z, dist, out, 6);
        return;
      }
      if (p.follow !== undefined) return this.tail(p, dist, out);
      // Ramming but only shoving at walking pace: back off for a run-up.
      if (p.arrive >= 30 && dist < 10 && Math.abs(forwardSpeed(w.player.vehicle!)) < 6) this.shoveTime += 1 / 60;
      else this.shoveTime = 0;
      if (this.shoveTime > 1) {
        this.shoveTime = 0;
        this.reverseTime = 1.6;
        this.reverseSteer = 0;
      }
      this.drive(p.x, p.z, dist, out, p.arrive);
      return;
    }

    // On foot.
    this.wedged = 0;
    this.wedgeDist = Infinity;
    const c = pc.context;
    if (p.press && c && p.press(c.kind, c.vehicleId, c.interactableId)) {
      this.press(out, true);
      return;
    }
    if (p.need === 'car' || (p.need === 'either' && dist > 45)) {
      if (this.goForCar(out, p.car)) return;
      if (p.need === 'car') {
        this.walk(p.x, p.z, out, 0);
        return;
      }
    }
    if (p.need === 'foot' && p.car < 0 && dist > 120 && this.goForCar(out, -1)) return;
    if (p.shoot && dist < 22 && w.police.lineOfSight(pc.x, pc.z, p.x, p.z)) {
      // Face the target by stepping towards it, then fire.
      const dx = p.x - pc.x;
      const dz = p.z - pc.z;
      pc.facing = Math.atan2(dx, dz);
      if (dist > p.stopAt) {
        out.moveX = (dx / dist) * 0.3;
        out.moveY = (-dz / dist) * 0.3;
      }
      if (this.fireCooldown <= 0) {
        out.fire = true;
        this.fireCooldown = 0.35;
      }
      if (this.dodgeCooldown <= 0 && pc.hp < pc.maxHp * 0.5) {
        out.dodge = true;
        this.dodgeCooldown = 2;
      }
      return;
    }
    this.walk(p.x, p.z, out, p.shoot ? 0 : p.stopAt);
  }

  /** A far road node away from the police, re-picked on arrival. */
  private escapePoint(px: number, pz: number): { x: number; z: number } {
    const w = this.world;
    const g = w.roads;
    const node = this.escapeNode >= 0 ? g.nodes[this.escapeNode] : undefined;
    if (!node || Math.hypot(node.x - px, node.z - pz) < 25) {
      let best = 0;
      let bs = -Infinity;
      for (const n of g.nodes) {
        let s = Math.min(Math.hypot(n.x - px, n.z - pz), 260);
        for (const v of w.vehicles) if (v.active && !v.destroyed && v.role === 'police') s += Math.min(120, Math.hypot(n.x - v.x, n.z - v.z)) * 0.5;
        s += Math.hypot(n.x - w.heat.lastKnownX, n.z - w.heat.lastKnownZ) * 0.5;
        if (n.id === this.escapeNode) s -= 1000;
        if (s > bs) {
          bs = s;
          best = n.id;
        }
      }
      this.escapeNode = best;
    }
    return g.nodes[this.escapeNode]!;
  }

  private tail(p: Plan, dist: number, out: Intents): void {
    const w = this.world;
    const v = w.player.vehicle!;
    const want = p.follow!;
    // Close the gap at speed when far, ease off when near.
    const arrive = dist > want + 15 ? 26 : dist > want ? 14 : dist > want * 0.7 ? 6 : 0;
    // Far too close ("Too close!"): back away from them, as a player would.
    if (p.backOff !== undefined && dist < p.backOff) {
      const dx = p.x - v.x;
      const dz = p.z - v.z;
      const ahead = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
      out.scheme = 'classic';
      if (ahead >= 0) {
        out.brake = 1;
        out.throttle = 0;
      } else {
        out.throttle = 1;
        out.brake = 0;
      }
      out.steer = 0;
      return;
    }
    if (arrive === 0) {
      this.stop(out);
      return;
    }
    this.drive(p.x, p.z, dist, out, arrive);
    if (dist < want && forwardSpeed(v) > 8) {
      out.throttle = 0;
      out.brake = 0.4;
    }
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
    out.handbrake = !!v && forwardSpeed(v) > 0.5;
  }

  /** Walk to the nearest usable car (or a given one) and get in. Returns false if none is close. */
  private goForCar(out: Intents, want: number): boolean {
    const w = this.world;
    const pc = w.playerCtl;
    let best: Vehicle | null = want >= 0 ? (w.vehicles[want] ?? null) : null;
    if (!best || !best.active || best.destroyed) {
      best = null;
      let bd = 32;
      for (const v of w.vehicles) {
        if (!v.active || v.destroyed || v.locked || v.hackable) continue;
        if (v.role !== 'parked' && v.role !== 'traffic') continue;
        const d = Math.hypot(v.x - pc.x, v.z - pc.z);
        if (d < bd) {
          bd = d;
          best = v;
        }
      }
    }
    if (!best) return false;
    const c = pc.context;
    // Any car will do and one is in reach: take it rather than walking round to a particular one.
    if (want < 0 && c && (c.kind === 'enter' || c.kind === 'steal')) {
      this.press(out, true);
      return true;
    }
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
    // Walking into a wall (sight lines see over low roofs): go round by the streets for a while.
    if (Math.hypot(pc.vx, pc.vz) < 0.3) this.walkStuck += 1 / 60;
    else this.walkStuck = Math.max(0, this.walkStuck - 1 / 60);
    if (this.walkStuck > 1.5) {
      this.walkRoute = 8;
      this.walkStuck = 0;
    }
    this.walkRoute = Math.max(0, this.walkRoute - 1 / 60);
    if (this.walkRoute > 0 || !w.police.lineOfSight(pc.x, pc.z, tx, tz)) {
      // Follow the street route (joins the nearest road at both ends), re-planned now and then.
      this.walkReplan -= 1 / 60;
      if (this.walkReplan <= 0 || Math.hypot(this.walkGoal.x - tx, this.walkGoal.z - tz) > 5) {
        this.walkPath = w.roads.route(pc.x, pc.z, tx, tz);
        this.walkGoal = { x: tx, z: tz };
        this.walkReplan = 3;
      }
      while (this.walkPath.length > 1 && Math.hypot(this.walkPath[0]!.x - pc.x, this.walkPath[0]!.z - pc.z) < 2.5) this.walkPath.shift();
      const p = this.walkPath[0] ?? { x: tx, z: tz };
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
  private routePoint(x: number, z: number, tx: number, tz: number, arrive = 6): { x: number; z: number } {
    const g = this.world.roads;
    if (this.waypoint < 0 || Math.hypot(g.nodes[this.waypoint]!.x - x, g.nodes[this.waypoint]!.z - z) > 450) {
      this.waypoint = nearestMain(g, x, z).id;
    }
    const wp = g.nodes[this.waypoint]!;
    if (Math.hypot(wp.x - x, wp.z - z) < arrive) this.waypoint = g.nextHop(wp.id, nearestMain(g, tx, tz).id);
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
    driveTowards(v, gx, gz, speed, c, arriveSpeed > 20);
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
