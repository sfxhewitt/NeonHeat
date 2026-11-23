/**
 * GameAudio: the one object the game talks to.
 *   audio.update(dt, listenerX, listenerZ, world)   every frame
 *   audio.onEvent(e)                                every sim event (unknown types are ignored)
 *   audio.ui('pickup'), audio.sting('missionComplete')
 * Nothing here throws into the game: with no Web Audio, or before the first gesture, calls are no-ops.
 */
import type { AudioConfig } from './config';
import * as D from './dsp';
import { AudioEngine } from './engine';
import { AmbienceAudio } from './ambience';
import { clamp, distanceGain, impactLevel, panFor } from './mix';
import { PoliceAudio } from './police';
import { RadioAudio } from './radio';
import { UiAudio, type StingName, type UiSound } from './ui-sounds';
import { VehicleAudio } from './vehicles';
import type { AudioEvent, AudioWorldView } from './view';

export interface SoundSettings {
  sound?: boolean;
  masterVolume?: number;
  musicVolume?: number;
  sfxVolume?: number;
  /** -1 = radio off. */
  radioStation?: number;
}

export interface StationInfo {
  name: string;
  frequency: string;
  colour: string;
}

const MELEE = new Set(['fists', 'fist', 'unarmed', 'melee', 'punch']);
const BLUNT = new Set(['bat', 'pipe', 'baton', 'club']);
const WOOD_PROPS = new Set(['bench', 'crate', 'tree', 'planter']);
const PLASTIC_PROPS = new Set(['bin', 'cone', 'trash']);
const GLASS_PROPS = new Set(['vending', 'kiosk', 'phone', 'payphone', 'window']);

type Ev = Record<string, unknown>;
const num = (e: Ev, k: string, d = 0): number => (typeof e[k] === 'number' ? (e[k] as number) : d);
const str = (e: Ev, k: string): string | null => (typeof e[k] === 'string' ? (e[k] as string) : null);

export class GameAudio {
  readonly engine: AudioEngine;
  private readonly vehicles: VehicleAudio;
  private readonly police: PoliceAudio;
  private readonly ambience: AmbienceAudio;
  readonly radio: RadioAudio;
  private readonly uiSounds: UiAudio;
  private lx = 0;
  private lz = 0;
  private world: AudioWorldView | null = null;
  private lastHeat = 0;
  private station: number;
  private enabled = true;
  private warned = false;
  private readonly impactCooldown = new Map<number, number>();
  private hurtCooldown = 0;
  private pedYelpCooldown = 0;
  private readonly pendingHorns: { at: number; id: number }[] = [];
  /** HUD hook: a station started (null = radio off). */
  onStation: ((s: StationInfo | null) => void) | null = null;

  constructor(readonly cfg: AudioConfig) {
    this.engine = new AudioEngine(cfg);
    this.vehicles = new VehicleAudio(this.engine, cfg);
    this.police = new PoliceAudio(this.engine, cfg);
    this.ambience = new AmbienceAudio(this.engine, cfg);
    this.radio = new RadioAudio(this.engine, cfg);
    this.uiSounds = new UiAudio(this.engine, cfg);
    this.station = clamp(cfg.radio.defaultStation, -1, cfg.radio.stations.length - 1);
    this.radio.onStation = (s) => this.onStation?.(s ? { name: s.name, frequency: s.frequency, colour: s.colour } : null);
    this.engine.onReady(() => this.registerSounds());
  }

  /** Unlock on the first gesture (and resume after iOS interruptions). */
  attach(target: Pick<Window, 'addEventListener'>): void {
    this.engine.attachUnlock(target);
  }

  get available(): boolean {
    return this.engine.running;
  }

  get stations(): StationInfo[] {
    return this.cfg.radio.stations.map((s) => ({ name: s.name, frequency: s.frequency, colour: s.colour }));
  }

  /** Current station choice (-1 = off). */
  get stationIndex(): number {
    return this.station;
  }

  applySettings(s: SoundSettings): void {
    this.enabled = s.sound !== false;
    this.engine.setVolumes({ enabled: this.enabled, master: s.masterVolume ?? 1, music: s.musicVolume ?? 1, sfx: s.sfxVolume ?? 1 });
    if (typeof s.radioStation === 'number') this.station = clamp(Math.round(s.radioStation), -1, this.cfg.radio.stations.length - 1);
  }

  /** Cycle to the next station, through "off". Returns the new index. */
  nextStation(): number {
    const n = this.cfg.radio.stations.length;
    this.station = this.station + 1 >= n ? -1 : this.station + 1;
    if (this.station < 0) this.onStation?.(null);
    return this.station;
  }

  setStation(i: number): void {
    this.station = clamp(Math.round(i), -1, this.cfg.radio.stations.length - 1);
  }

  setPaused(p: boolean): void {
    this.guard(() => this.engine.setPaused(p));
  }

  setHidden(h: boolean): void {
    this.guard(() => this.engine.setHidden(h));
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn('Audio error (sound continues where it can)', err);
      }
    }
  }

  private registerSounds(): void {
    const e = this.engine;
    const LO = 24000;
    // Weapons first: they are the most likely to be heard straight away.
    for (const [name, recipe] of Object.entries(D.SHOTS)) e.register(`shot:${name}`, (sr, r) => D.renderShot(sr, recipe, r));
    e.register('taser', (sr, r) => D.renderTaser(sr, r), 2);
    e.register('swing', (sr, r) => D.renderWhoosh(sr, r, 0.2, 500, 2200), 3);
    e.register('swingHeavy', (sr, r) => D.renderWhoosh(sr, r, 0.28, 300, 1300, 1.4), 2);
    e.register('punch', (sr, r) => D.renderPunch(sr, r));
    e.register('batHit', (sr, r) => D.renderBatHit(sr, r));
    e.register('dryClick', (sr, r) => D.renderDryClick(sr, r), 2);
    e.register('reload', (sr, r) => D.renderReload(sr, r), 1);
    e.register('ricochet', (sr, r) => D.renderRicochet(sr, r));
    e.register('hit:metal', (sr, r) => D.renderBulletHit(sr, r, true));
    e.register('hit:concrete', (sr, r) => D.renderBulletHit(sr, r, false));
    e.register('thud', (sr, r) => D.renderThud(sr, r), 3, LO);
    e.register('footstep', (sr, r) => D.renderFootstep(sr, r), 4);
    e.register('door', (sr, r) => D.renderDoor(sr, r), 2, LO);
    e.register('whoosh', (sr, r) => D.renderWhoosh(sr, r, 0.32, 350, 1500, 1.2), 2, LO);
    e.register('crunch:light', (sr, r) => D.renderCrunch(sr, r, 0.15));
    e.register('crunch:medium', (sr, r) => D.renderCrunch(sr, r, 0.5));
    e.register('crunch:heavy', (sr, r) => D.renderCrunch(sr, r, 1));
    e.register('glass', (sr, r) => D.renderGlass(sr, r, 0.6), 2);
    e.register('struck:wood', (sr, r) => D.renderStruck(sr, r, 'wood'), 2, LO);
    e.register('struck:plastic', (sr, r) => D.renderStruck(sr, r, 'plastic'), 2, LO);
    e.register('struck:metal', (sr, r) => D.renderStruck(sr, r, 'metal'), 2);
    e.register('kerb', (sr, r) => D.renderKerb(sr, r), 3, LO);
    e.register('pop', (sr, r) => D.renderPop(sr, r), 3, LO);
    e.register('explosion', (sr, r) => D.renderExplosion(sr, r, 1), 2, LO);
    e.register('spray', (sr, r) => D.renderSpray(sr, r), 1, LO);
    e.register('fizz', (sr, r) => D.renderFizz(sr, r), 1);
    e.register('static', (sr, r) => D.renderStatic(sr, r, this.cfg.radio.staticSec + 0.05), 2, LO);
    for (const kind of ['scream', 'yelp', 'hey', 'ow', 'hurt'] as const) e.register(`vocal:${kind}`, (sr, r) => D.renderVocal(sr, r, kind), 3, LO);
    e.register('chatter', (sr, r) => D.renderChatter(sr, r), 4, 16000);
    e.register('rainLoop', (sr, r) => D.renderRainLoop(sr, r), 1, 32000);
    e.register('pinkLoop', (sr, r) => D.renderNoise(sr, r, 4, 'pink'), 1, LO);
    e.register('brownLoop', (sr, r) => D.renderNoise(sr, r, 4, 'brown'), 1, 16000);
    e.register('crackleLoop', (sr, r) => D.renderCrackleLoop(sr, r), 1, LO);
    this.radio.registerKits();
    e.register('fireLoop', (sr, r) => D.renderFireLoop(sr, r), 1, 16000);
    e.register('crowdLoop', (sr, r) => D.renderCrowdLoop(sr, r, 6, 5), 1, 16000);
  }

  /** Per frame. Listener = the camera's focus on the ground. */
  update(dt: number, lx: number, lz: number, w: AudioWorldView): void {
    this.lx = lx;
    this.lz = lz;
    this.world = w;
    if (!this.engine.ctx) return;
    this.guard(() => {
      const e = this.engine;
      e.pump(e.pending > 0 ? 5 : 0);
      if (!e.running) return;
      const lvx = w.player.vx;
      const lvz = w.player.vz;
      this.vehicles.update(dt, lx, lz, lvx, lvz, w);
      this.police.update(dt, lx, lz, lvx, lvz, w);
      this.ambience.update(dt, lx, lz, w);
      this.hurtCooldown -= dt;
      this.pedYelpCooldown -= dt;

      const heat = w.heat.level;
      if (heat > this.lastHeat) this.uiSounds.play('heatUp', heat);
      else if (heat < this.lastHeat) this.uiSounds.play('heatDown');
      this.lastHeat = heat;

      const want = this.enabled && w.player.vehicle !== null && this.station >= 0 ? this.station : -1;
      if (want !== this.radio.playing) {
        if (want < 0) this.radio.off();
        else this.radio.tune(want, true);
      }
      this.radio.update();

      for (let i = this.pendingHorns.length - 1; i >= 0; i--) {
        const h = this.pendingHorns[i]!;
        if (e.now < h.at) continue;
        this.pendingHorns.splice(i, 1);
        const v = w.vehicles.find((c) => c.id === h.id && c.active && !c.destroyed);
        if (v) {
          const s = this.spot(v.x, v.z);
          this.vehicles.horn(s.g, s.pan, 0.25 + e.random() * 0.45, 0.9 + e.random() * 0.25);
        }
      }
    });
  }

  /** Gain and pan for a world position. */
  private spot(x: number, z: number): { g: number; pan: number; d: number } {
    const dx = x - this.lx;
    const d = Math.hypot(dx, z - this.lz);
    return { g: distanceGain(d, this.cfg.listener), pan: panFor(dx, this.cfg.listener), d };
  }

  private at(name: string, x: number, z: number, gain: number, rateJitter = 0.08, delay = 0): void {
    const s = this.spot(x, z);
    this.engine.play(name, gain * s.g, s.pan, 1 + (this.engine.random() - 0.5) * 2 * rateJitter, delay);
  }

  /** Forward every sim event. Unknown types are ignored, so new events never break audio. */
  onEvent(ev: AudioEvent): void {
    if (!this.engine.running) return;
    this.guard(() => this.handle(ev as unknown as Ev));
  }

  private handle(e: Ev): void {
    const c = this.cfg;
    const x = num(e, 'x', this.lx);
    const z = num(e, 'z', this.lz);
    const eng = this.engine;
    switch (e.type) {
      case 'impact': {
        const strength = num(e, 'strength');
        const im = c.impacts;
        const lv = impactLevel(strength, im.minStrength, im.fullStrength);
        if (lv <= 0) return;
        const vid = num(e, 'vehicleId', -1);
        const now = eng.now;
        if ((this.impactCooldown.get(vid) ?? 0) > now) return;
        this.impactCooldown.set(vid, now + im.cooldownSec);
        const other = str(e, 'other');
        if (other === 'ped' || other === 'player') {
          this.at('thud', x, z, im.bodyGain * (0.5 + lv * 0.5));
          if (this.pedYelpCooldown <= 0) {
            this.pedYelpCooldown = 0.5;
            const s = this.spot(x, z);
            this.ambience.vocal(eng.random() < 0.5 ? 'ow' : 'yelp', x - this.lx, s.d);
          }
          return;
        }
        if (other === 'prop') {
          this.at('crunch:light', x, z, im.gain * 0.5 * lv);
          return;
        }
        const name = lv > 0.66 ? 'crunch:heavy' : lv > 0.3 ? 'crunch:medium' : 'crunch:light';
        this.at(name, x, z, im.gain * (0.35 + 0.65 * lv), 0.1);
        if (strength >= im.glassStrength) this.at('glass', x, z, im.gain * 0.6 * lv, 0.1, 0.02);
        if (strength >= im.glassStrength * 1.4) eng.duckMusic(0.3, 0.4);
        // A traffic driver who just got hit leans on the horn.
        if (other === 'vehicle' && e.involvesPlayer === true && eng.random() < 0.6) {
          const otherId = num(e, 'otherId', -1);
          const pv = this.world?.player.vehicle?.id ?? -1;
          const target = otherId === pv ? vid : otherId;
          const v = this.world?.vehicles.find((q) => q.id === target);
          if (v && v.role === 'traffic') this.pendingHorns.push({ at: now + 0.3 + eng.random() * 0.4, id: target });
        }
        return;
      }
      case 'vehicleDestroyed':
      case 'explosion':
      case 'grenadeExploded': {
        const s = this.spot(x, z);
        const size = clamp(num(e, 'strength', 1), 0.5, 1.5);
        eng.play('explosion', c.impacts.explosionGain * Math.max(s.g, 0.12) * size, s.pan, 0.9 + eng.random() * 0.15);
        this.at('glass', x, z, c.impacts.gain * 0.5, 0.1, 0.05);
        if (s.d < 60) eng.duckMusic(0.7 * (1 - s.d / 60), 1.2);
        return;
      }
      case 'shot':
        this.shot(e, x, z);
        return;
      case 'melee':
        this.melee(str(e, 'weapon') ?? 'fists', e.hit !== false && e.hit !== 'none', x, z);
        return;
      case 'pedHit': {
        this.at('thud', x, z, c.impacts.bodyGain * 0.8);
        if (this.pedYelpCooldown <= 0) {
          this.pedYelpCooldown = 0.4;
          const s = this.spot(x, z);
          this.ambience.vocal(eng.random() < 0.6 ? 'ow' : 'scream', x - this.lx, s.d, 0.9);
        }
        return;
      }
      case 'playerHurt':
        if (this.hurtCooldown <= 0) {
          this.hurtCooldown = 0.7;
          if (!this.world?.player.vehicle) eng.play('vocal:hurt', c.ambience.screamGain * 0.6, 0, 0.9 + eng.random() * 0.1);
          eng.play('thud', c.impacts.bodyGain * 0.6, 0);
        }
        return;
      case 'playerDied':
      case 'wasted':
        this.vehicles.silence();
        this.uiSounds.sting('wasted');
        return;
      case 'busted':
      case 'playerBusted':
        this.uiSounds.sting('busted');
        return;
      case 'playerRespawned':
        this.uiSounds.sting('respawn');
        return;
      case 'enteredVehicle':
      case 'exitedVehicle':
        this.at('door', x, z, 0.55, 0.06);
        return;
      case 'dodge':
        this.at('whoosh', x, z, 0.45, 0.1);
        return;
      case 'kerb': {
        const im = c.impacts;
        const lv = impactLevel(num(e, 'strength'), im.kerbMinStrength, 18);
        if (lv <= 0) return;
        this.at('kerb', x, z, im.kerbGain * (0.3 + 0.7 * lv) * (e.up === false ? 0.6 : 1), 0.1);
        return;
      }
      case 'propBroken':
        this.prop(str(e, 'kind') ?? '', x, z);
        return;
      case 'interact':
        this.uiSounds.play('blip');
        return;
      case 'hackRequested':
        this.uiSounds.play('hackStart');
        return;
      case 'pickup':
      case 'weaponPickup':
      case 'healthPickup':
      case 'armourPickup':
      case 'ammoPickup':
        if (str(e, 'kind') === 'money' || str(e, 'kind') === 'credits') this.uiSounds.play('cash');
        else this.uiSounds.play('pickup');
        return;
      case 'moneyPickup':
      case 'cash':
      case 'credits':
        this.uiSounds.play('cash');
        return;
      case 'missionStarted':
      case 'missionStart':
        this.uiSounds.sting('missionStart');
        return;
      case 'missionComplete':
      case 'missionCompleted':
        this.uiSounds.sting('missionComplete');
        return;
      case 'missionFailed':
      case 'missionFail':
        this.uiSounds.sting('missionFail');
        return;
      case 'checkpoint':
      case 'objectiveComplete':
        this.uiSounds.play('checkpoint');
        return;
      case 'reload':
        this.at('reload', x, z, c.weapons.gain * 0.5, 0.03);
        return;
      case 'dryFire':
      case 'emptyClick':
      case 'outOfAmmo':
        this.at('dryClick', x, z, c.weapons.gain * 0.6, 0.05);
        return;
      case 'weaponSwitched':
      case 'weaponChanged':
        this.uiSounds.play('select');
        return;
      case 'horn': {
        const s = this.spot(x, z);
        this.vehicles.horn(s.g, s.pan, num(e, 'duration', 0.4));
        return;
      }
      default:
        return;
    }
  }

  private shot(e: Ev, x: number, z: number): void {
    const c = this.cfg.weapons;
    const weapon = str(e, 'weapon') ?? str(e, 'weaponId') ?? 'pistol';
    const hit = str(e, 'hit') ?? 'none';
    if (MELEE.has(weapon) || BLUNT.has(weapon)) {
      this.melee(weapon, hit !== 'none', x, z);
      return;
    }
    const level = c.gain * (c.levels[weapon] ?? c.levels.pistol ?? 1);
    const s = this.spot(x, z);
    // Gunfire carries: never fully inaudible on screen.
    const g = level * Math.max(s.g, 0.08);
    if (weapon === 'taser') this.engine.play('taser', g, s.pan, 0.95 + this.engine.random() * 0.1);
    else {
      const recipe = weapon in D.SHOTS ? weapon : weapon === 'grenade' || weapon === 'grenadeLauncher' ? 'launcher' : 'pistol';
      this.engine.play(`shot:${recipe}`, g, s.pan, 0.94 + this.engine.random() * 0.12);
    }
    const hx = num(e, 'hx', x);
    const hz = num(e, 'hz', z);
    if (hit === 'vehicle') this.at('hit:metal', hx, hz, c.bulletHitGain, 0.1, 0.01);
    else if (hit === 'static') {
      if (this.engine.random() < c.ricochetChance) this.at('ricochet', hx, hz, c.bulletHitGain * 0.7, 0.12, 0.02);
      else this.at('hit:concrete', hx, hz, c.bulletHitGain * 0.8, 0.1, 0.01);
    } else if (hit === 'ped') this.at('thud', hx, hz, c.bulletHitGain * 0.7, 0.1, 0.01);
  }

  private melee(weapon: string, hit: boolean, x: number, z: number): void {
    const blunt = BLUNT.has(weapon);
    const g = this.cfg.weapons.gain * (this.cfg.weapons.levels[weapon] ?? 0.6);
    this.at(blunt ? 'swingHeavy' : 'swing', x, z, g * 0.6, 0.1);
    if (hit) this.at(blunt ? 'batHit' : 'punch', x, z, g, 0.08, blunt ? 0.09 : 0.06);
  }

  private prop(kind: string, x: number, z: number): void {
    const g = this.cfg.impacts.propGain;
    if (GLASS_PROPS.has(kind)) {
      this.at('glass', x, z, g, 0.08);
      this.at('struck:metal', x, z, g * 0.5, 0.1);
      this.at('fizz', x, z, g * 0.5, 0.05, 0.05);
    } else if (kind === 'hydrant') {
      this.at('struck:metal', x, z, g, 0.08);
      this.at('spray', x, z, g * 0.6, 0.05, 0.03);
    } else if (kind === 'lamp') {
      this.at('struck:metal', x, z, g, 0.12);
      this.at('glass', x, z, g * 0.5, 0.1, 0.25);
      this.at('fizz', x, z, g * 0.4, 0.05, 0.05);
    } else if (WOOD_PROPS.has(kind)) {
      this.at('struck:wood', x, z, g, 0.1);
      if (kind === 'tree') this.at('crunch:light', x, z, g * 0.4, 0.1, 0.05);
    } else if (PLASTIC_PROPS.has(kind)) this.at('struck:plastic', x, z, g, 0.12);
    else if (kind === 'bollard' || kind === 'barrier' || kind === 'sign' || kind === 'dumpster') this.at('struck:metal', x, z, g, 0.12);
    else this.at('struck:plastic', x, z, g * 0.8, 0.12);
  }

  /** Named interface sound (menus, pickups, hack panel, HEAT tones). `arg` is e.g. a hack node index. */
  ui(name: UiSound, arg = 0): void {
    this.guard(() => this.uiSounds.play(name, arg));
  }

  /** Music sting over the radio (mission start / complete / fail, wasted, busted). */
  sting(name: StingName): void {
    this.guard(() => this.uiSounds.sting(name));
  }
}
