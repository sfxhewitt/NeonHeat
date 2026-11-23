import type * as THREE from 'three';
import type { ActivityProgress, SimEvent, World } from '@neonheat/sim';
import type { ActivitiesSave } from '@neonheat/save';
import { ActivitiesView, type CameraRig, type LightField } from '@neonheat/engine';
import { ActivityHud, clock, ordinal, type ActivityMarker, type Hud, type InputManager } from '@neonheat/ui';
import type { GameAudio } from '@neonheat/audio';
import type { FlowActivityHooks } from './flow';

export interface ActivitiesLayerDeps {
  scene: THREE.Scene;
  overlay: HTMLElement;
  hud: Hud;
  input: InputManager;
  rig: CameraRig;
  audio: GameAudio;
  vibrate: (ms: number) => void;
  /** Copy progress into the save and write it. */
  persist: (p: ActivitiesSave) => void;
  /** True while a job runs: activities stand down. */
  jobActive: () => boolean;
}

const NOUNS: Record<string, string> = { wreck: 'CARS WRECKED', smash: 'PROPS SMASHED', takedown: 'CREW DOWN' };
const FARE_KICKER: Record<string, string> = { passenger: 'TAXI', parcel: 'COURIER' };

/**
 * The game-side half of the side activities: the world view, the HUD panel,
 * countdowns, result cards and jump readouts, the activity button, map markers
 * and Stats rows, sounds and haptics, the slow-motion beat on a big jump, and
 * writing progress to the save. Kept out of game.ts so the wiring stays small.
 */
export class ActivitiesLayer implements FlowActivityHooks {
  readonly view: ActivitiesView;
  private readonly ui: ActivityHud;
  /** Multiplies the frame time fed to the fixed-step loop (slow motion on a big jump). */
  timeScale = 1;
  private slowLeft = 0;
  private lastCount = '';
  private readonly markerPool: ActivityMarker[] = [];

  constructor(
    private readonly world: World,
    private readonly d: ActivitiesLayerDeps,
  ) {
    this.view = new ActivitiesView(d.scene, world);
    this.ui = new ActivityHud(d.hud.root, d.overlay);
  }

  /** After a save loads. */
  load(save: ActivitiesSave): void {
    this.world.activities.load(save as ActivityProgress);
  }

  private save(): void {
    this.d.persist(JSON.parse(JSON.stringify(this.world.activities.progress)) as ActivitiesSave);
  }

  // ---- FlowActivityHooks --------------------------------------------------

  target(): { x: number; z: number } | null {
    const a = this.world.activities;
    const race = a.races.run;
    if (race) return race.phase === 'run' ? a.races.checkpoint(race.player.next) : null;
    const rr = a.rampages.run;
    if (rr) {
      // A takedown points at the nearest of the crew still standing.
      let best: { x: number; z: number } | null = null;
      let bd = Infinity;
      const pl = this.world.player;
      for (const m of rr.gang) {
        const p = m.active && !m.dead && m.pedId >= 0 ? this.world.peds.peds[m.pedId] : undefined;
        if (!p || !p.active) continue;
        const dd = Math.hypot(p.x - pl.x, p.z - pl.z);
        if (dd < bd) {
          bd = dd;
          best = { x: p.x, z: p.z };
        }
      }
      return best;
    }
    const shift = a.fares.shift;
    if (shift) {
      const s = shift.phase === 'seek' ? shift.pickup : shift.drop;
      return { x: s.laneX, z: s.laneZ };
    }
    return null;
  }

  markers(out: ActivityMarker[], x: number, z: number): void {
    const a = this.world.activities;
    if (!a.enabled || a.current) return;
    const p = a.progress;
    let n = 0;
    const push = (mx: number, mz: number, kind: ActivityMarker['kind'], done: boolean, title: string): void => {
      const m = (this.markerPool[n++] ??= { x: 0, z: 0, kind, done, title });
      m.x = mx;
      m.z = mz;
      m.kind = kind;
      m.done = done;
      m.title = title;
      out.push(m);
    };
    for (const t of a.rampages.tokens) push(t.site.x, t.site.z, 'rampage', (p.rampages[t.def.id]?.passes ?? 0) > 0, t.def.title);
    for (const r of a.sites.ramps) {
      const L = r.up;
      push(r.x + Math.sin(r.yaw) * L, r.z + Math.cos(r.yaw) * L, 'jump', !!p.jumps[r.id]?.unique, 'Stunt ramp');
    }
    for (const f of a.sites.flags) push(f.x, f.z, 'race', (p.races[f.id]?.wins ?? 0) > 0, a.races.defOf(f.id)?.title ?? 'Street race');
    const reveal = a.config?.shards.revealRange ?? 0;
    a.sites.shards.forEach((s, i) => {
      if (!a.shards.found[i] && Math.hypot(s.x - x, s.z - z) < reveal) push(s.x, s.z, 'shard', false, 'Data shard');
    });
  }

  stats(): { label: string; value: string }[] {
    const a = this.world.activities;
    const p = a.progress;
    const cfg = a.config;
    const n = (v: number): string => v.toLocaleString('en-GB');
    const passed = Object.values(p.rampages).filter((r) => r.passes > 0).length;
    const unique = Object.values(p.jumps).filter((j) => j.unique).length;
    const longest = Object.values(p.jumps).reduce((m, j) => Math.max(m, j.best), 0);
    const won = Object.values(p.races).filter((r) => r.wins > 0).length;
    const taxi = p.fares.taxi;
    const courier = p.fares.courier;
    const streak = Object.values(p.fares).reduce((m, f) => Math.max(m, f.bestStreak), 0);
    return [
      { label: 'Havoc runs cleared', value: `${passed} / ${cfg?.rampages.defs.length ?? 0}` },
      { label: 'Unique jumps', value: `${unique} / ${a.sites.ramps.length}` },
      { label: 'Longest jump', value: longest > 0 ? `${longest.toFixed(1)} m` : '—' },
      { label: 'Data shards', value: `${a.shards.count} / ${a.shards.total}` },
      { label: 'Street races won', value: `${won} / ${a.sites.flags.length}` },
      { label: 'Taxi fares', value: n(taxi?.done ?? 0) },
      { label: 'Courier drops', value: n(courier?.done ?? 0) },
      { label: 'Best fare streak', value: n(streak) },
    ];
  }

  // ---- Events ---------------------------------------------------------------

  /** Returns true when the event was handled here. */
  onEvent(e: SimEvent): boolean {
    const d = this.d;
    const a = this.world.activities;
    const ui = this.ui;
    switch (e.type) {
      case 'jumpTakeoff': {
        if (e.vehicleId !== this.world.player.vehicle?.id || !a.config) return true;
        const sm = a.config.jumps.slowMo;
        if (e.rampId && e.air >= sm.minAirSec) {
          this.slowLeft = sm.sec;
          this.timeScale = sm.scale;
          d.rig.heightScale = sm.heightScale;
        }
        d.vibrate(18);
        return true;
      }
      case 'jumpLanded': {
        if (!e.byPlayer) return true;
        d.rig.addShake(Math.min(0.9, 0.15 + e.impact * 0.05));
        d.vibrate(e.impact > 6 ? 60 : 25);
        if (e.rampId && e.distance >= 6) {
          const ramp = a.sites.ramps.find((r) => r.id === e.rampId);
          ui.jump({ distance: e.distance, air: e.air, height: e.height, reward: e.reward, unique: e.unique, best: e.best, target: ramp?.target ?? 0 });
          if (e.reward > 0) d.audio.ui(e.unique ? 'hackGood' : 'cash');
          if (e.unique || e.best) this.save();
        }
        return true;
      }
      case 'shardFound':
        ui.shard(e.found, e.total, e.milestone);
        d.audio.ui(e.milestone > 0 ? 'hackGood' : 'pickup');
        d.vibrate(e.milestone > 0 ? 40 : 15);
        this.save();
        return true;
      case 'rampage': {
        const def = a.config?.rampages.defs.find((r) => r.id === e.id);
        if (!def) return true;
        if (e.phase === 'ready') {
          ui.show('rampage', 'HAVOC', def.title);
          this.lastCount = '';
          d.audio.sting('missionStart');
          d.vibrate(30);
        } else if (e.phase === 'go') {
          ui.countdown('GO', true);
          d.audio.ui('checkpoint');
        } else if (e.phase === 'progress') {
          d.audio.ui('blip');
          d.vibrate(10);
        } else {
          ui.hide();
          if (e.phase === 'passed') {
            ui.result({ tone: 'pass', kind: 'rampage', kicker: 'HAVOC · CLEARED', title: def.title.toUpperCase(), lines: [{ label: NOUNS[def.kind] ?? 'COUNT', value: `${e.count} / ${e.target}` }, { label: 'TIME', value: clock(e.seconds, true) }], reward: e.reward });
            d.audio.sting('missionComplete');
            this.save();
          } else if (e.phase === 'failed') {
            ui.result({ tone: 'fail', kind: 'rampage', kicker: 'HAVOC · FAILED', title: 'OUT OF TIME', lines: [{ label: NOUNS[def.kind] ?? 'COUNT', value: `${e.count} / ${e.target}` }], reward: 0 }, 3);
            d.audio.sting('missionFail');
          }
        }
        return true;
      }
      case 'race': {
        const def = a.races.defOf(e.id);
        if (!def) return true;
        if (e.phase === 'countdown') {
          ui.show('race', 'STREET RACE', def.title, def.colour);
          this.lastCount = '';
          d.audio.sting('missionStart');
        } else if (e.phase === 'go') {
          ui.countdown('GO', true);
          d.audio.ui('checkpoint');
          d.vibrate(40);
        } else if (e.phase === 'checkpoint' || e.phase === 'lap') {
          d.audio.ui('checkpoint');
          d.vibrate(12);
          if (e.phase === 'lap') d.hud.toast(e.lap === e.laps ? 'FINAL LAP' : `LAP ${e.lap}`, performance.now(), 1.4);
        } else {
          ui.hide();
          if (e.phase === 'finished') {
            const win = e.place === 1;
            const lines = [
              { label: 'TIME', value: clock(e.seconds, true) },
              { label: 'PLACE', value: `${e.place} / ${e.racers}` },
            ];
            if (e.best) lines.push({ label: 'RECORD', value: 'NEW BEST' });
            ui.result({ tone: win ? 'pass' : 'neutral', kind: 'race', kicker: `STREET RACE · ${def.title.toUpperCase()}`, title: `${ordinal(e.place)} PLACE`, lines, reward: e.reward }, 4);
            d.audio.sting(win ? 'missionComplete' : 'missionFail');
            this.save();
          } else if (e.phase === 'failed') {
            ui.result({ tone: 'fail', kind: 'race', kicker: 'STREET RACE', title: 'RACE LOST', lines: e.reason ? [{ label: 'WHY', value: e.reason }] : [], reward: 0 }, 3);
            d.audio.sting('missionFail');
          }
        }
        return true;
      }
      case 'fare': {
        const job = a.fares.jobs[e.job];
        if (!job) return true;
        const kicker = FARE_KICKER[job.cargo] ?? job.name.toUpperCase();
        const kind = job.cargo === 'parcel' ? 'parcel' : 'fare';
        if (e.phase === 'onDuty') {
          ui.show(kind, kicker, job.cargo === 'parcel' ? 'On the clock' : 'On duty');
          d.audio.ui('select');
        } else if (e.phase === 'newFare') {
          d.audio.ui('blip');
        } else if (e.phase === 'pickedUp') {
          d.hud.toast(job.cargo === 'parcel' ? 'PARCEL LOADED' : 'FARE ON BOARD', performance.now(), 1.2);
          d.audio.ui('checkpoint');
          d.vibrate(15);
        } else if (e.phase === 'delivered') {
          const lines = [
            { label: 'FARE', value: `${e.pay.toLocaleString('en-GB')} cr` },
            { label: 'TIP', value: `${e.tip.toLocaleString('en-GB')} cr` },
          ];
          if (e.bonus > 0) lines.push({ label: `STREAK ×${e.streak}`, value: `${e.bonus.toLocaleString('en-GB')} cr` });
          ui.result({ tone: 'pass', kind, kicker, title: job.cargo === 'parcel' ? 'DELIVERED' : 'FARE PAID', lines, reward: e.pay + e.tip + e.bonus }, 2.4);
          d.audio.ui('cash');
          this.save();
        } else if (e.phase === 'lost') {
          ui.result({ tone: 'fail', kind, kicker, title: job.cargo === 'parcel' ? 'DROP MISSED' : 'FARE LOST', lines: e.reason ? [{ label: 'WHY', value: e.reason }] : [], reward: 0 }, 2.6);
          d.audio.ui('deny');
        } else if (e.phase === 'offDuty') {
          ui.hide();
          d.hud.toast('OFF DUTY', performance.now(), 1.4);
          this.save();
        }
        return true;
      }
      default:
        return false;
    }
  }

  // ---- Frame ----------------------------------------------------------------

  update(alpha: number, dt: number, focusX: number, focusZ: number): void {
    const w = this.world;
    const a = w.activities;
    a.enabled = !this.d.jobActive();
    this.view.update(w, alpha, w.time, focusX, focusZ);

    // Slow motion fades back to full speed over its last quarter second.
    if (this.slowLeft > 0) {
      this.slowLeft -= dt;
      const sm = a.config?.jumps.slowMo;
      if (this.slowLeft <= 0 || !sm) {
        this.timeScale = 1;
        this.d.rig.heightScale = 1;
      } else if (this.slowLeft < 0.25) {
        const k = this.slowLeft / 0.25;
        this.timeScale = 1 + (sm.scale - 1) * k;
        this.d.rig.heightScale = 1 + (sm.heightScale - 1) * k;
      }
    }

    // The activity button follows the sim's prompt.
    this.d.input.touch.setActivity(this.d.jobActive() ? null : (a.prompt?.label ?? null));

    // Live airtime.
    const pv = w.player.vehicle;
    const fl = a.jumps.flight;
    const airT = fl ? w.time - fl.t : 0;
    this.ui.air(fl && pv && pv.airborne && airT > 0.25 ? airT : null, fl ? fl.maxY : 0);

    // The running activity's panel.
    const rr = a.rampages.run;
    const race = a.races.run;
    const shift = a.fares.shift;
    if (rr) {
      if (this.ui.open !== 'rampage') this.ui.show('rampage', 'HAVOC', rr.def.title);
      if (rr.phase === 'ready') this.count(Math.ceil(rr.timeLeft));
      this.ui.rampage(rr.count, rr.def.target, rr.phase === 'ready' ? rr.def.timeSec : rr.timeLeft, NOUNS[rr.def.kind] ?? '');
    } else if (race) {
      if (this.ui.open !== 'race') this.ui.show('race', 'STREET RACE', race.def.title, race.def.colour);
      if (race.phase === 'countdown') this.count(Math.ceil(race.countdown));
      const n = race.route.xs.length;
      const cp = race.player.next - Math.floor(race.player.next / n) * n;
      this.ui.race(race.place, race.opponents.length + 1, a.races.lap, race.def.laps, Math.min(n, cp + (race.player.finished ? n : 0)), n, race.elapsed);
    } else if (shift) {
      const kind = shift.def.cargo === 'parcel' ? 'parcel' : 'fare';
      if (this.ui.open !== kind) this.ui.show(kind, FARE_KICKER[shift.def.cargo] ?? shift.def.name, shift.def.name);
      const phase = shift.phase === 'seek' ? (shift.def.cargo === 'parcel' ? 'COLLECT' : 'PICK UP') : shift.def.cargo === 'parcel' ? 'DELIVER' : 'DROP OFF';
      const parcel = shift.def.cargo === 'parcel';
      this.ui.setTitle(shift.phase === 'seek' ? (parcel ? 'Parcel waiting' : 'Fare waving at the kerb') : parcel ? 'Get it there in one piece' : 'Get them there fast');
      this.ui.fare(phase, shift.timeLeft, shift.timeTotal, shift.streak, shift.done, shift.earned);
    } else if (this.ui.open) this.ui.hide();
  }

  private count(n: number): void {
    const t = n > 0 ? String(n) : '';
    if (t === this.lastCount) return;
    this.lastCount = t;
    if (t) {
      this.ui.countdown(t);
      this.d.audio.ui('blip');
    }
  }

  /** After the light field's frame has begun (SceneLights.update). */
  light(field: LightField): void {
    this.view.light(field);
  }
}
