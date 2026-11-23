import * as THREE from 'three';
import { SkyGrade } from './sky';
import { FixedStepLoop, SIM_DT, World, emptyIntents, forwardSpeed, initPhysics, type Intents, type Prop, type SimEvent } from '@neonheat/sim';
import { MissionBot, MissionDirector, type MissionResult } from '@neonheat/missions';
import { IndexedDbStorage, MemoryStorage, SaveManager, applyMissionResult } from '@neonheat/save';
import {
  BlobShadows,
  CameraRig,
  DroneView,
  DynamicResolution,
  LightField,
  MarkersView,
  Palette,
  Particles,
  PeopleView,
  PostFx,
  PropsView,
  SignalsView,
  Rain,
  SceneLights,
  SkidMarks,
  VehiclesView,
  Viewport,
  buildCity,
  buildNoiseTexture,
  buildReflectionTexture,
  buildSignage,
  createWetRoadMaterial,
  layoutSigns,
  type CityMeshes,
  waterTime,
  type TierName,
} from '@neonheat/engine';
import {
  DebugPanel,
  EdgeArrow,
  HackOverlay,
  Hud,
  InputManager,
  loadSettings,
  showFailScreen,
  type Settings,
} from '@neonheat/ui';
import { loadGameContent, type GameContent } from './content';
import { GameFlow } from './flow';
import { setupTuning } from './tuning';
import { CombatLayer } from './combat-layer';
import { LifeLayer } from './life-layer';
import { SoundBridge } from './sound';
import { EconomyLayer } from './economy-layer';

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
  private markers!: MarkersView;
  private lightField!: LightField;
  private propsView!: PropsView;
  private skids!: SkidMarks;
  private sceneLights!: SceneLights;
  private combat!: CombatLayer;
  /** Shops, resprays, safehouses, cyberware, exports (apps/game/src/economy-layer.ts). */
  economy!: EconomyLayer;
  private life!: LifeLayer;
  private signs!: { stream: (x: number, z: number) => void };
  private signals!: SignalsView;
  private readonly hemi = new THREE.HemisphereLight(0x7a74b0, 0x241228, 0.8);
  private readonly key = new THREE.DirectionalLight(0xc0b0ff, 0.85);
  private readonly sky = new SkyGrade();
  private perfEl: HTMLElement | null = null;
  private perfTimer = 0;
  director!: MissionDirector;
  /** Set with ?bot=1: the mission bot plays through the intent layer (demo and soak test). */
  bot: MissionBot | null = null;
  readonly saves: SaveManager;
  private readonly hackUi: HackOverlay;
  private readonly arrow: EdgeArrow;
  private closeFail: (() => void) | null = null;
  private hackHideTimer = 0;
  private freeRoamSaveTimer = 0;
  private giversShown = false;
  /** The last completed job (time, damage, pay, respect), for the result card and tests. */
  lastResult: MissionResult | null = null;
  private readonly projected = new THREE.Vector3();
  readonly postfx: PostFx;
  tier: TierName = 'mid';
  private dynRes: DynamicResolution | null = null;
  /** Set while the first-boot benchmark runs, so dynamic resolution does not flatter the result. */
  holdResolution = false;
  readonly hud: Hud;
  /** Sound layer: engines, guns, sirens, ambience, radio, UI. */
  readonly sound: SoundBridge;
  /** Remaining hit-stop, seconds of frozen simulation. */
  private hitStop = 0;
  private smokeTimer = 0;
  private smokeN = 0;
  private readonly intents: Intents = emptyIntents();
  private paused = false;
  private last = 0;
  readonly stats: GameStats = { fps: 0, frameMs: 0, tickMs: 0, drawCalls: 0, triangles: 0, frames: 0 };
  /** Rolling frame times for tests (ms). */
  readonly frameTimes: number[] = [];
  /** Front end: title, pause menu, maps, cards, stats (apps/game/src/flow.ts). */
  readonly flow: GameFlow;
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
    this.arrow = new EdgeArrow(overlay);
    this.hackUi = new HackOverlay(overlay);
    this.sound = new SoundBridge(this.content.audio, this.settings);
    this.saves = new SaveManager(typeof indexedDB === 'undefined' ? new MemoryStorage() : new IndexedDbStorage());
    this.flow = new GameFlow(this, () => !this.closeFail);
  }

  async init(seed = 1): Promise<void> {
    const rapier = await initPhysics();
    this.world = new World({ seed, content: this.content.sim, rapier });
    this.buildScene();
    this.flow.init();
    const params = new URLSearchParams(location.search);
    this.setupMissions(params.has('bot'));
    this.sound.attach(this);
    const p = this.world.player;
    this.rig.snap({ x: p.x, z: p.z, vx: 0, vz: 0, speedT: 0, onFoot: !p.vehicle });
    if (import.meta.env.DEV || params.has('debug')) this.setupDebug();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.setPaused(true);
      else if (!this.flow.blocking && !this.closeFail) this.setPaused(false);
    });
    await this.saves.load().catch((err: unknown) => console.warn('Save unavailable', err));
    const save = this.saves.current;
    this.director.setProgress({ completed: save.completedMissions, respect: save.respect });
    this.world.score.credits = this.saves.current.credits;
    this.economy.applySave(save);
    this.saves.beforeSave = (s) => this.economy.capture(s);
  }

  private setupMissions(bot: boolean): void {
    const mc = this.content.missions;
    this.world.actors.configure(mc.actors);
    const d = new MissionDirector(this.world, mc.missions, mc.squads, mc.dialogue, { autoRetry: bot, crews: mc.crews });
    this.director = d;
    d.onWarning = (msg) => console.warn(`Missions: ${msg}`);
    for (const msg of d.warnings) console.warn(`Missions: ${msg}`);
    d.onGiversChanged = () => (this.giversShown = false);
    const coarse = matchMedia('(pointer: coarse)').matches;
    d.host.onHint = (text, desktop, seconds) => this.hud.showHint(!coarse && desktop ? desktop : text, undefined, seconds);
    if (bot) this.bot = new MissionBot(this.world, d);
    d.host.onDialogue = (speaker, text) => this.hud.showDialogue(speaker, text, performance.now(), 6);
    d.onStart = (m) => this.flow.missionStarted(m);
    d.onHackStart = () => {
      this.hackHideTimer = 0;
      this.hackUi.show((n) => d.hackTap(n));
    };
    d.onHackEnd = (ok) => {
      this.hud.toast(ok ? 'LOCK OPEN' : 'BREACH FAILED', performance.now(), 1.5);
      this.hackHideTimer = 0.6;
    };
    d.onFail = (reason) => {
      this.hud.toast('JOB FAILED', performance.now(), 2);
      if (this.bot) return; // the director retries on its own
      this.setPaused(true);
      this.closeFail = showFailScreen(this.overlay, reason, [
        { label: 'Retry from checkpoint', run: () => this.afterFail(() => d.retry()) },
        { label: 'Restart job', run: () => this.afterFail(() => d.restart()) },
        { label: 'Walk away', run: () => this.afterFail(() => d.abandon()) },
      ]);
    };
    d.onComplete = (r) => {
      this.lastResult = r;
      const mins = `${Math.floor(r.seconds / 60)}:${String(Math.floor(r.seconds % 60)).padStart(2, '0')}`;
      this.hud.toast(`JOB DONE  ${mins}\n+${r.pay.total.toLocaleString('en-GB')} cr`, performance.now(), 3.5, 2);
      this.saves.current = applyMissionResult(this.saves.current, r.missionId, { credits: r.pay.total, rep: r.respect, unlocks: r.unlocks }, r.seconds);
      this.world.score.credits = this.saves.current.credits;
      this.autosave('mission end');
      this.flow.missionCompleted(r);
    };
  }

  private afterFail(action: () => void): void {
    this.closeFail = null;
    action();
    this.snapCamera();
    this.setPaused(this.flow.blocking);
  }

  restartJob(): void {
    this.director.restart();
    this.snapCamera();
  }

  walkAway(): void {
    this.director.abandon();
  }

  private snapCamera(): void {
    const p = this.world.player;
    this.rig.snap({ x: p.x, z: p.z, vx: 0, vz: 0, speedT: 0, onFoot: !p.vehicle });
  }

  autosave(why: string): void {
    this.freeRoamSaveTimer = 0;
    this.saves.save().catch((err: unknown) => console.warn(`Autosave (${why}) failed`, err));
  }

  private buildScene(): void {
    const s = this.scene;
    s.background = new THREE.Color(Palette.bg);
    s.fog = new THREE.Fog(Palette.fog, 90, 260);
    s.add(this.hemi);
    this.key.position.set(-40, 100, 30);
    s.add(this.key);
    const map = this.content.sim.map;
    this.economy = new EconomyLayer(this, s);
    const signs = this.economy.view.clearSigns(layoutSigns(map));
    // Shop fronts light the street and show in the wet road like the other signs.
    const litSigns = [...signs, ...this.economy.view.lights()];
    this.lightField = new LightField(map);
    this.roadMat = createWetRoadMaterial(map, buildReflectionTexture(map, litSigns), buildNoiseTexture(), this.lightField.uniforms);
    this.city = buildCity(s, map, this.roadMat);
    this.propsView = new PropsView(s, this.world.props.props);
    this.signals = new SignalsView(s, this.world.roads, this.world.content.traffic.lights);
    this.sceneLights = new SceneLights(this.lightField, this.city.lamps, litSigns, this.propsView.lights());
    this.signs = buildSignage(s, signs);
    this.shadows = new BlobShadows(s);
    this.vehiclesView = new VehiclesView(s, this.content.sim.vehicles.variants);
    this.particles = new Particles(s, 384);
    this.skids = new SkidMarks(s);
    this.people = new PeopleView(s, this.content.sim.peds.colours);
    this.markers = new MarkersView(s);
    this.droneView = new DroneView(s, this.content.sim.heat.droneSightRange);
    this.life = new LifeLayer(this.particles);
    this.combat = new CombatLayer(this.world, {
      scene: s,
      overlay: this.overlay,
      hud: this.hud,
      input: this.input,
      particles: this.particles,
      lights: this.sceneLights,
      rig: this.rig,
      vibrate: (ms) => {
        if (this.settings.vibration && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
      },
    });
    const top = this.content.quality.tiers.ultra;
    this.rain = new Rain(s, top.rainStreaks, top.rainSplashes, this.lightField.uniforms);
    this.postfx.addOccluder(
      this.city.buildings,
      this.city.roofProps,
      this.city.lampPosts,
      ...this.vehiclesView.bodies,
      this.vehiclesView.wheels,
      ...this.people.meshes,
      ...this.propsView.meshes,
      this.economy.view.structure,
    );
    // Everything solid receives the real-time light field; paint and glass also pick up a wet sheen.
    const lf = this.lightField;
    const mats = (m: THREE.Object3D): THREE.Material[] => {
      const mm = (m as THREE.Mesh).material;
      return Array.isArray(mm) ? mm : [mm];
    };
    const seen = new Set<THREE.Material>();
    const lit = (gloss: number, ...objs: THREE.Object3D[]): void => {
      for (const o of objs)
        for (const m of mats(o)) {
          if (seen.has(m)) continue;
          seen.add(m);
          lf.inject(m, { gloss });
        }
    };
    lit(0.55, ...this.vehiclesView.bodies);
    lit(0.12, this.city.buildings, this.city.pavements, this.city.ground, this.economy.view.structure);
    lit(0.7, this.city.water);
    lit(0, this.city.roofProps, this.city.lampPosts, this.vehiclesView.wheels, ...this.people.meshes, ...this.propsView.meshes, this.particles.debris.mesh);
  }

  /** Apply a quality tier: resolution cap, bloom, rain and simulation caps. */
  applyQuality(tier: TierName): void {
    const q = this.content.quality.tiers[tier];
    this.tier = tier;
    this.viewport.maxPixelRatio = q.maxPixelRatio;
    this.viewport.resolutionScale = 1;
    this.viewport.update();
    this.postfx.enabled = q.bloom;
    this.postfx.ssr = q.ssr;
    this.postfx.threshold = q.bloomThreshold;
    this.lightField.configure(q.lighting);
    this.city.lightPools.visible = q.lighting.size === 0;
    this.city.lampCones.visible = q.lighting.shadowSteps > 0;
    this.vehiclesView.beamStrength = q.lighting.size === 0 ? 0.5 : 0.14;
    this.roadMat.uniforms.uFakeRefl!.value = q.ssr ? 0 : q.lighting.size > 0 ? 0.45 : 1;
    this.rain.visible = q.rain;
    this.rain.setCounts(q.rainStreaks, q.rainSplashes);
    this.world.peds.cap = q.peds;
    this.world.traffic.cap = q.traffic;
    this.world.police.cap = q.police;
    this.world.services.cap = q.responders;
    this.world.gangs.cap = q.gangMembers;
    this.world.gangs.carCap = q.gangCars;
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
    this.sound.audio.setPaused(p);
    this.loop.reset();
  }

  get isPaused(): boolean {
    return this.paused;
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
    if (this.dynRes && !this.paused && !this.holdResolution) {
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
      // Reflex cyberware slows the whole clock for a moment after a dodge.
      alpha = this.loop.advance(dt * this.economy.timeScale, () => this.simStep());
    }
    const pc = this.world.playerCtl;
    this.input.setMode(this.flow.blocking ? 'menu' : pc.mode === 'driving' ? 'driving' : 'foot', pc.context?.label ?? null);
    this.render(alpha, dt);
    this.sound.frame(dt);
    if (this.holdResolution) {
      // Benchmark only: wait for the GPU so the sample is the real cost of the frame, even where
      // the browser would otherwise keep handing out frames while the work queues up.
      const gl = this.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.syncPixel);
      this.benchTimes.push(Math.max(elapsedMs, performance.now() - now));
    }
    this.debug?.update(now);
  };
  private readonly syncPixel = new Uint8Array(4);
  /** Frame costs measured during the first-boot benchmark (GPU work included). */
  readonly benchTimes: number[] = [];

  /** One fixed 60 Hz step: input, sim, missions, events, autosave. */
  simStep(): void {
    if (this.hitStop > 0) return;
    const t0 = performance.now();
    this.input.sample(this.intents);
    if (this.bot && !this.input.override) Object.assign(this.intents, this.bot.next(SIM_DT));
    // The hack panel takes the player's hands off the controls.
    if (this.director.hack) Object.assign(this.intents, emptyIntents(), { scheme: this.intents.scheme });
    this.world.step(this.intents);
    this.director.tick(SIM_DT);
    this.stats.tickMs = performance.now() - t0;
    for (const e of this.world.events) {
      this.onSimEvent(e);
      this.flow.onSimEvent(e);
    }
    this.saves.current.credits = Math.max(0, Math.floor(this.world.score.credits));
    this.saves.current.stats.playSeconds += SIM_DT;
    if (!this.director.active) {
      this.freeRoamSaveTimer += SIM_DT;
      if (this.freeRoamSaveTimer >= 120) this.autosave('free roam');
    }
  }

  /** Run simulation steps synchronously without rendering (tests). Skips hit-stop. */
  fastForward(seconds: number): void {
    const n = Math.round(seconds / SIM_DT);
    for (let i = 0; i < n; i++) {
      this.hitStop = 0;
      this.simStep();
    }
    this.loop.reset();
  }

  private updateMissionHud(dt: number): void {
    const d = this.director;
    const r = d.runner;
    if (d.hack) this.hackUi.update(d.hack);
    if (this.hackHideTimer > 0) {
      this.hackHideTimer -= dt;
      if (this.hackHideTimer <= 0 && !d.hack) this.hackUi.hide();
    }
    if (r && r.state === 'running') {
      const v = r.view;
      const t = v.timeLeft;
      const timer = t === null ? null : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
      this.hud.setObjective(v.text, timer);
      const o = r.objective;
      const radius = o && 'radius' in o ? o.radius : 3;
      this.markers.setTarget(v.targetX, v.targetZ, radius, this.world.time);
      const p = this.projected.set(v.targetX, 0, v.targetZ).project(this.rig.camera);
      this.arrow.setTone(false);
      this.arrow.set(p.x, p.y, p.z > 1);
      if (this.giversShown) this.markers.setGivers([]);
      this.giversShown = false;
    } else {
      this.hud.setObjective(null, null);
      this.markers.setTarget(null);
      // Free roam: point at the nearest job payphone.
      let best = Infinity;
      let gx = 0;
      let gz = 0;
      const pl = this.world.player;
      for (const g of d.givers) {
        const dist = Math.hypot(g.x - pl.x, g.z - pl.z);
        if (dist < best) {
          best = dist;
          gx = g.x;
          gz = g.z;
        }
      }
      if (best < Infinity && !d.active) {
        const p = this.projected.set(gx, 0, gz).project(this.rig.camera);
        this.arrow.setTone(true);
        this.arrow.set(p.x, p.y, p.z > 1);
      } else this.arrow.set(null);
      if (!d.active && !this.giversShown) {
        this.markers.setGivers(d.givers);
        this.giversShown = true;
      }
    }
  }

  /** Tier and frame-rate readout (pause menu line, and an optional corner overlay). */
  perfLine(): string {
    const names: Record<TierName, string> = { low: 'Low', mid: 'Mid', high: 'High', ultra: 'Max' };
    const px = this.renderer.getPixelRatio();
    return `${names[this.tier]} graphics · ${this.stats.fps.toFixed(0)} fps · ${px.toFixed(2)}× pixels · ${this.lightField.count} lights`;
  }

  private updatePerf(dt: number): void {
    if (!this.settings.perf) {
      if (this.perfEl) this.perfEl.hidden = true;
      return;
    }
    if (!this.perfEl) {
      this.perfEl = document.createElement('div');
      this.perfEl.className = 'nh-perf';
      this.overlay.appendChild(this.perfEl);
    }
    this.perfEl.hidden = false;
    this.perfTimer -= dt;
    if (this.perfTimer > 0) return;
    this.perfTimer = 0.5;
    this.perfEl.textContent = this.perfLine();
  }

  /** Lamp props the renderer draws as street lights, and lit props, with the state last drawn. */
  private lightProps: { prop: Prop; shown: boolean }[] | null = null;

  /** Knocked-down lamps lie flat and go dark; smashed vending machines and kiosks stop lighting the street. */
  private syncBrokenLights(): void {
    this.lightProps ??= this.world.props.props
      .filter((p) => p.lamp >= 0 || p.kind === 'vending' || p.kind === 'kiosk')
      .map((prop) => ({ prop, shown: true }));
    for (const s of this.lightProps) {
      const on = !s.prop.broken;
      if (on === s.shown) continue;
      s.shown = on;
      if (s.prop.lamp >= 0) {
        this.city.setLampDown(s.prop.lamp, !on);
        this.sceneLights.setLampOn(s.prop.lamp, on);
      } else this.sceneLights.setPropLightOn(s.prop.id, on);
    }
  }

  private onSimEvent(e: SimEvent): void {
    this.sound.audio.onEvent(e);
    this.life.onEvent(e);
    if (this.economy.onEvent(e)) return;
    if (this.combat.onEvent(e)) return;
    const feel = this.content.feel;
    if (e.type === 'impact') {
      const n = Math.min(feel.sparksMax, Math.round(e.strength * feel.sparksPerStrength));
      if (n > 0) this.particles.burstSparks(e.x, e.z, n, e.strength);
      if (e.strength > 6) this.sceneLights.flash(e.x, e.z, 0xffb060, 0.12);
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
      this.sceneLights.flash(e.x, e.z, 0xff8a3a, 0.6);
      if (e.vehicleId === this.world.player.vehicle?.id) this.hud.toast('WRECKED', performance.now());
    } else if (e.type === 'shot') {
      const dx = e.hx - e.x;
      const dz = e.hz - e.z;
      const len = Math.hypot(dx, dz) || 1;
      this.particles.muzzle(e.x, 1.0, e.z, dx / len, dz / len);
      this.sceneLights.flash(e.x + (dx / len) * 0.8, e.z + (dz / len) * 0.8, 0xffc070);
      this.people.addTracer(e.x, e.z, e.hx, e.hz);
      if (e.hit !== 'none') this.particles.burstSparks(e.hx, e.hz, e.hit === 'vehicle' ? 7 : 4, 2);
      this.rig.addShake(0.1);
      if (this.settings.vibration && typeof navigator.vibrate === 'function') navigator.vibrate(e.hit === 'none' ? 6 : 12);
    } else if (e.type === 'kerb') {
      if (!e.byPlayer) return;
      this.rig.addShake(Math.min(feel.kerbShakeMax, e.strength * feel.kerbShakePerStrength * (e.up ? 1 : 0.5)));
      if (e.up && this.settings.vibration && typeof navigator.vibrate === 'function') navigator.vibrate(feel.kerbVibrateMs);
    } else if (e.type === 'propBroken') {
      const heavy = e.kind === 'tree' || e.kind === 'vending' || e.kind === 'lamp';
      const solidKinds = heavy || e.kind === 'bollard' || e.kind === 'hydrant';
      this.particles.burstDebris(e.x, e.z, e.vx, e.vz, this.propsView.debrisColour(e.kind), heavy ? 16 : solidKinds ? 6 : 12, e.kind === 'hydrant');
      if (e.kind === 'vending' || e.kind === 'lamp') {
        this.particles.burstSparks(e.x, e.z, 14, 8);
        this.sceneLights.flash(e.x, e.z, e.kind === 'lamp' ? 0xffd090 : 0x9fe8ff, 0.18);
      }
      if (e.byPlayer) {
        this.rig.addShake(heavy ? 0.55 : solidKinds ? 0.35 : 0.2);
        if (this.settings.vibration && typeof navigator.vibrate === 'function') navigator.vibrate(heavy ? 40 : solidKinds ? 25 : 12);
      }
    } else if (e.type === 'pedHit') {
      if (e.byPlayer) this.rig.addShake(0.3);
    } else if (e.type === 'playerHurt') {
      this.rig.addShake(Math.min(1.2, e.amount * 0.03));
      if (this.settings.vibration && typeof navigator.vibrate === 'function') navigator.vibrate(40);
    } else if (e.type === 'playerRespawned') {
      this.rig.snap({ x: e.x, z: e.z, vx: 0, vz: 0, speedT: 0, onFoot: true });
      this.hud.toast('PATCHED UP', performance.now(), 2);
    }
  }

  private render(alpha: number, dt: number): void {
    const w = this.world;
    this.vehiclesView.update(w, alpha, dt);
    this.droneView.update(w.police.drone, alpha, w.time);
    this.skids.update(w, w.time);
    this.smokeTimer -= dt;
    if (this.smokeTimer <= 0) {
      this.smokeTimer = 0.08;
      this.smokeN++;
      const sm = this.skids.smoke;
      for (let i = 0; i < sm.length; i += 2) this.particles.puffSmoke(sm[i]!, sm[i + 1]!, false);
      for (const v of w.vehicles) {
        if (!v.active) continue;
        const h = v.hp / v.params.maxHealth;
        // Wrecks smoke while they burn (black, greying as the fire is fought); damaged cars smoke from the engine.
        if (v.destroyed) {
          const burn = w.services.burnOf(v.id);
          if (burn > 0.01 && (this.smokeN & 1) === 0) this.particles.wreckSmoke(v.x, v.z, burn);
        } else if (h < 0.35) this.particles.puffSmoke(v.x, v.z, false);
      }
    }
    this.life.update(w, dt);
    this.particles.update(dt);
    this.rig.shakeMax = this.content.feel.shakeMax;
    this.rig.shakeDecay = this.content.feel.shakeDecay;
    const heat = w.heat;
    this.hud.setHeat(heat.level, heat.seen && Math.floor(w.time * 4) % 2 === 0);
    const pv0 = w.player.vehicle;
    this.hud.setSpeed(pv0 ? Math.abs(forwardSpeed(pv0)) * 3.6 : null);
    this.hud.setHealth(pv0 ? w.vehicleHealth(pv0) : w.playerCtl.hp / w.playerCtl.maxHp, pv0 ? 'HULL' : 'BODY');
    this.hud.setTrace(w.trace);
    this.updateMissionHud(dt);
    this.flow.update(dt);
    this.hud.tick(performance.now());
    this.people.update(w, alpha, dt, w.time);
    this.combat.update(alpha, dt);
    this.economy.update();
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
    (this.city.lampCones.material as THREE.ShaderMaterial).uniforms.uTime!.value = w.time;
    this.renderer.getDrawingBufferSize(this.city.viewport);
    const fp = this.projected.copy(this.city.focus).project(this.rig.camera);
    this.city.focusScreen.set(fp.x * 0.5 + 0.5, fp.y * 0.5 + 0.5);
    // Stream the city near the camera: buildings, lamps, props and signs.
    this.city.stream(focus.x, focus.z - 20);
    this.propsView.stream(focus.x, focus.z - 15);
    this.signs.stream(focus.x, focus.z - 20);
    this.signals.update(focus.x, focus.z - 15, w.time);
    this.sky.apply(w.weather, this.scene, this.hemi, this.key, this.rain, this.roadMat);
    waterTime.value = w.time;
    this.propsView.update();
    this.syncBrokenLights();
    this.sceneLights.update(w, alpha, this.paused ? 0 : dt, focus.x, focus.z - 12);
    // Centre the light buffer a little ahead (north) of the focus: the camera sees further up the screen.
    this.lightField.render(this.renderer, focus.x, focus.z - 12);
    this.postfx.render(this.scene, this.rig.camera);
    this.updatePerf(dt);
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
  }
}
