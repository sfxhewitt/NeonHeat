import * as THREE from 'three';
import { FixedStepLoop, World, emptyIntents, forwardSpeed, initPhysics, type Intents, type SimEvent } from '@neonheat/sim';
import {
  BlobShadows,
  CameraRig,
  DroneView,
  DynamicResolution,
  Palette,
  Particles,
  PeopleView,
  PostFx,
  Rain,
  VehiclesView,
  Viewport,
  buildCity,
  buildNoiseTexture,
  buildReflectionTexture,
  buildSignage,
  createWetRoadMaterial,
  layoutSigns,
  type CityMeshes,
  type TierName,
} from '@neonheat/engine';
import { DebugPanel, Hud, InputManager, SettingsMenu, loadSettings, storeSettings, type Settings } from '@neonheat/ui';
import { loadGameContent, type GameContent } from './content';
import { setupTuning } from './tuning';

export interface GameStats {
  fps: number;
  frameMs: number;
  tickMs: number;
  drawCalls: number;
  triangles: number;
  frames: number;
}

/** Owns the loop and wires sim, engine, UI and input together. */
export class Game {
  readonly content: GameContent;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly viewport: Viewport;
  readonly rig: CameraRig;
  readonly input: InputManager;
  readonly loop = new FixedStepLoop();
  readonly settings: Settings;
  world!: World;
  private vehiclesView!: VehiclesView;
  private particles!: Particles;
  private people!: PeopleView;
  private city!: CityMeshes;
  private droneView!: DroneView;
  private shadows!: BlobShadows;
  private rain!: Rain;
  private roadMat!: THREE.ShaderMaterial;
  readonly postfx: PostFx;
  tier: TierName = 'mid';
  private dynRes: DynamicResolution | null = null;
  readonly hud: Hud;
  /** Remaining hit-stop, seconds of frozen simulation. */
  private hitStop = 0;
  private smokeTimer = 0;
  private readonly intents: Intents = emptyIntents();
  private paused = false;
  private last = 0;
  readonly stats: GameStats = { fps: 0, frameMs: 0, tickMs: 0, drawCalls: 0, triangles: 0, frames: 0 };
  /** Rolling frame times for tests (ms). */
  readonly frameTimes: number[] = [];
  private readonly menu: SettingsMenu;
  debug: DebugPanel | null = null;
  /** Hook for the app shell (quality changes need the benchmark result). */
  onSettingsChanged: ((s: Settings) => void) | null = null;

  constructor(
    readonly canvas: HTMLCanvasElement,
    readonly overlay: HTMLElement,
  ) {
    this.content = loadGameContent();
    this.settings = loadSettings();
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.setClearColor(Palette.bg);
    // Count draw calls across all passes of a frame (scene, bloom, blur, composite).
    this.renderer.info.autoReset = false;
    this.viewport = new Viewport(this.renderer, canvas);
    this.rig = new CameraRig(this.content.camera);
    this.postfx = new PostFx(this.renderer);
    this.viewport.onResize(({ width, height, pixelRatio }) => {
      this.rig.setAspect(width / height);
      this.postfx.setSize(width, height, pixelRatio);
    });
    this.viewport.update();
    this.input = new InputManager(overlay, this.settings.scheme);
    this.hud = new Hud(overlay);
    this.menu = new SettingsMenu(overlay, {
      settings: this.settings,
      onChange: (s) => {
        storeSettings(s);
        this.input.touch.setScheme(s.scheme);
        this.onSettingsChanged?.(s);
      },
      onEditLayout: (on) => this.input.touch.setEditing(on),
      onResetLayout: () => this.input.touch.resetLayout(),
      onOpen: () => this.setPaused(true),
      onClose: () => this.setPaused(false),
    });
  }

  async init(seed = 1): Promise<void> {
    const rapier = await initPhysics();
    this.world = new World({ seed, content: this.content.sim, rapier });
    this.buildScene();
    const p = this.world.player;
    this.rig.snap({ x: p.x, z: p.z, vx: 0, vz: 0, speedT: 0, onFoot: !p.vehicle });
    const params = new URLSearchParams(location.search);
    if (import.meta.env.DEV || params.has('debug')) this.setupDebug();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.setPaused(true);
      else if (!this.menu.isOpen) this.setPaused(false);
    });
  }

  private buildScene(): void {
    const s = this.scene;
    s.background = new THREE.Color(Palette.bg);
    s.fog = new THREE.Fog(Palette.fog, 90, 260);
    s.add(new THREE.HemisphereLight(0x9a8cff, 0x2a1030, 2.2));
    const key = new THREE.DirectionalLight(0xd0c0ff, 1.6);
    key.position.set(-40, 100, 30);
    s.add(key);
    const map = this.content.sim.map;
    const signs = layoutSigns(map);
    this.roadMat = createWetRoadMaterial(map, buildReflectionTexture(map, signs), buildNoiseTexture());
    this.city = buildCity(s, map, this.roadMat);
    buildSignage(s, signs);
    this.shadows = new BlobShadows(s);
    this.vehiclesView = new VehiclesView(s);
    this.particles = new Particles(s);
    this.people = new PeopleView(s, this.content.sim.peds.colours);
    this.droneView = new DroneView(s, this.content.sim.heat.droneSightRange);
    const top = this.content.quality.tiers.high;
    this.rain = new Rain(s, top.rainStreaks, top.rainSplashes);
    this.postfx.addOccluder(this.city.buildings, this.vehiclesView.body, this.vehiclesView.cabin);
  }

  /** Apply a quality tier: resolution cap, bloom, rain and simulation caps. */
  applyQuality(tier: TierName): void {
    const q = this.content.quality.tiers[tier];
    this.tier = tier;
    this.viewport.maxPixelRatio = q.maxPixelRatio;
    this.viewport.resolutionScale = 1;
    this.viewport.update();
    this.postfx.enabled = q.bloom;
    this.rain.visible = q.rain;
    this.rain.setCounts(q.rainStreaks, q.rainSplashes);
    this.world.peds.cap = q.peds;
    this.world.traffic.cap = q.traffic;
    this.world.police.cap = q.police;
    this.dynRes = q.dynamicResolution ? new DynamicResolution(this.content.quality.dynamicResolution) : null;
  }

  private setupDebug(): void {
    const debug = new DebugPanel();
    this.debug = debug;
    debug.addStat('fps', () => this.stats.fps.toFixed(0));
    debug.addStat('frame ms', () => this.stats.frameMs.toFixed(2));
    debug.addStat('draw calls', () => String(this.stats.drawCalls));
    debug.addStat('triangles', () => String(this.stats.triangles));
    debug.addStat('sim tick ms', () => this.stats.tickMs.toFixed(3));
    debug.addStat('quality', () => `${this.tier} @ ${this.viewport.resolutionScale.toFixed(2)}x`);
    debug.addStat('speed km/h', () => (Math.abs(this.world.playerSpeed()) * 3.6).toFixed(0));
    setupTuning(debug, this);
  }

  setPaused(p: boolean): void {
    this.paused = p;
    this.loop.reset();
  }

  onVehicleParamsChanged(_variant: string): void {
    // Params are edited in place and read every step. Mass needs pushing into the physics collider.
    for (const v of this.world.vehicles) {
      if (v.active && v.collider && v.collider.mass() !== v.params.mass) v.collider.setMass(v.params.mass);
    }
  }

  respawnPlayerCar(variant?: string): void {
    const w = this.world;
    const old = w.player.vehicle;
    const x = old?.x ?? w.player.x + 3;
    const z = old?.z ?? w.player.z;
    const yaw = old?.yaw ?? 0;
    if (old) {
      w.playerCtl.exit();
      w.despawnVehicle(old);
    }
    const v = w.spawnVehicle(variant ?? old?.variantId ?? 'kestrel', x, z, yaw, 'parked');
    if (v) w.playerCtl.enter(v);
  }

  start(): void {
    this.last = performance.now();
    requestAnimationFrame(this.frame);
  }

  private readonly frame = (now: number): void => {
    requestAnimationFrame(this.frame);
    const elapsedMs = now - this.last;
    this.last = now;
    const dt = Math.min(0.25, elapsedMs / 1000);
    const st = this.stats;
    st.frames++;
    st.frameMs = elapsedMs;
    st.fps += (1000 / Math.max(elapsedMs, 0.1) - st.fps) * 0.05;
    this.frameTimes.push(elapsedMs);
    if (this.dynRes && !this.paused) {
      const scale = this.dynRes.sample(elapsedMs);
      if (scale !== null) this.viewport.setResolutionScale(scale);
    }
    if (this.frameTimes.length > 600) this.frameTimes.shift();

    let alpha = 1;
    if (!this.paused && this.hitStop > 0) {
      // Hit-stop: freeze the sim for a beat but keep rendering (and shaking).
      this.hitStop -= dt;
      alpha = 1;
    } else if (!this.paused) {
      alpha = this.loop.advance(dt, () => {
        if (this.hitStop > 0) return;
        const t0 = performance.now();
        this.input.sample(this.intents);
        this.world.step(this.intents);
        st.tickMs = performance.now() - t0;
        for (const e of this.world.events) this.onSimEvent(e);
      });
    }
    const pc = this.world.playerCtl;
    this.input.setMode(this.menu.isOpen ? 'menu' : pc.mode === 'driving' ? 'driving' : 'foot', pc.context?.label ?? null);
    this.render(alpha, dt);
    this.debug?.update(now);
  };

  private onSimEvent(e: SimEvent): void {
    const feel = this.content.feel;
    if (e.type === 'impact') {
      const n = Math.min(feel.sparksMax, Math.round(e.strength * feel.sparksPerStrength));
      if (n > 0) this.particles.burstSparks(e.x, e.z, n, e.strength);
      if (!e.involvesPlayer) return;
      this.rig.addShake(Math.min(feel.shakeMax, e.strength * feel.shakePerStrength));
      if (e.strength >= feel.hitStopMinStrength && this.hitStop <= 0) {
        this.hitStop = Math.min(feel.hitStopMaxMs, feel.hitStopBaseMs + e.strength * feel.hitStopPerStrengthMs) / 1000;
      }
      if (e.strength >= feel.vibrateMinStrength && this.settings.vibration && typeof navigator.vibrate === 'function') {
        navigator.vibrate(Math.min(feel.vibrateMaxMs, feel.vibrateBaseMs + e.strength * feel.vibratePerStrengthMs));
      }
    } else if (e.type === 'vehicleDestroyed') {
      this.particles.burstSparks(e.x, e.z, 30, 20);
      if (e.vehicleId === this.world.player.vehicle?.id) this.hud.toast('WRECKED', performance.now());
    } else if (e.type === 'shot') {
      const dx = e.hx - e.x;
      const dz = e.hz - e.z;
      const len = Math.hypot(dx, dz) || 1;
      this.particles.muzzle(e.x, 1.0, e.z, dx / len, dz / len);
      this.people.addTracer(e.x, e.z, e.hx, e.hz);
      if (e.hit !== 'none') this.particles.burstSparks(e.hx, e.hz, 4, 2);
      this.rig.addShake(0.08);
    } else if (e.type === 'pedHit') {
      if (e.byPlayer) this.rig.addShake(0.3);
    } else if (e.type === 'playerHurt') {
      this.rig.addShake(Math.min(1.2, e.amount * 0.03));
      if (this.settings.vibration && typeof navigator.vibrate === 'function') navigator.vibrate(40);
    } else if (e.type === 'playerDied') {
      this.hud.toast('FLATLINED', performance.now(), 3);
    } else if (e.type === 'playerRespawned') {
      this.rig.snap({ x: e.x, z: e.z, vx: 0, vz: 0, speedT: 0, onFoot: true });
      this.hud.toast('PATCHED UP', performance.now(), 2);
    }
  }

  private render(alpha: number, dt: number): void {
    const w = this.world;
    this.vehiclesView.update(w, alpha);
    this.droneView.update(w.police.drone, alpha, w.time);
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0) {
      this.smokeTimer = 0.08;
      for (const v of w.vehicles) {
        if (!v.active) continue;
        const h = v.hp / v.params.maxHealth;
        if (v.destroyed || h < 0.35) this.particles.puffSmoke(v.x, v.z, v.destroyed);
      }
    }
    this.particles.update(dt);
    this.rig.shakeMax = this.content.feel.shakeMax;
    this.rig.shakeDecay = this.content.feel.shakeDecay;
    const heat = w.heat;
    this.hud.setHeat(heat.level, heat.seen && Math.floor(w.time * 4) % 2 === 0);
    const pv0 = w.player.vehicle;
    this.hud.setSpeed(pv0 ? Math.abs(forwardSpeed(pv0)) * 3.6 : null);
    this.hud.setHealth(pv0 ? w.vehicleHealth(pv0) : w.playerCtl.hp / w.playerCtl.maxHp, pv0 ? 'HULL' : 'BODY');
    this.hud.tick(performance.now());
    this.people.update(w, alpha, dt, w.time);
    const pv = w.player.vehicle;
    if (pv) {
      const x = pv.prevX + (pv.x - pv.prevX) * alpha;
      const z = pv.prevZ + (pv.z - pv.prevZ) * alpha;
      this.rig.update({ x, z, vx: pv.vx, vz: pv.vz, speedT: Math.abs(forwardSpeed(pv)) / pv.params.topSpeed, onFoot: false }, dt);
      this.city.focus.set(x, 1, z);
    } else {
      const pc = w.playerCtl;
      const x = pc.prevX + (pc.x - pc.prevX) * alpha;
      const z = pc.prevZ + (pc.z - pc.prevZ) * alpha;
      this.rig.update({ x, z, vx: pc.vx * 0.5, vz: pc.vz * 0.5, speedT: 0, onFoot: true }, dt);
      this.city.focus.set(x, 1, z);
    }
    this.renderer.info.reset();
    this.shadows.update(w, alpha);
    const focus = this.rig.focus;
    this.rain.update(w.time, focus.x, focus.z);
    this.roadMat.uniforms.uTime!.value = w.time;
    this.postfx.render(this.scene, this.rig.camera);
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
  }
}
