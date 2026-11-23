import type { SimEvent } from '@neonheat/sim';
import type { Mission, MissionResult } from '@neonheat/missions';
import { newSave } from '@neonheat/save';
import {
  Cards,
  FullMap,
  Minimap,
  PauseMenu,
  districtAt,
  distanceToRoute,
  emptyLiveState,
  geometryFromMap,
  showTitle,
  storeSettings,
  straightRoute,
  type BigCard,
  type JobsView,
  type MapGeometry,
  type MapLiveState,
  type RouteFn,
  type SettingsPanelHooks,
  type TitleChoice,
} from '@neonheat/ui';
import type { Game } from './game';

/** How the shell (boot.ts) plugs audio into the front end. All optional. */
export interface FlowAudioHooks {
  /** First user gesture on the title screen: create/resume the AudioContext here. */
  onFirstGesture?: () => void;
  /** "Test sound" in Settings. */
  onTestSound?: () => void;
}

const HINTS_KEY = 'neonheat.hints.v1';

/** Side activities feed the maps, the GPS and the Stats tab through these (apps/game/src/activities-layer.ts). */
export interface FlowActivityHooks {
  /** Where the running activity wants the player to go (next checkpoint, fare stop), or null. */
  target(): { x: number; z: number } | null;
  /** Fill the map markers (cleared first). */
  markers(out: MapLiveState['activities'], x: number, z: number): void;
  /** Extra rows for the Stats tab. */
  stats(): { label: string; value: string }[];
}

/**
 * The game's front end and flow, kept out of game.ts: title screen, pause menu
 * (Map / Jobs / Stats / Settings), minimap and full map with GPS, job and
 * death/arrest cards, lifetime stats and first-time hints. game.ts calls
 * `update(dt)` every rendered frame and `onSimEvent(e)` for each sim event.
 */
export class GameFlow {
  readonly cards: Cards;
  readonly menu: PauseMenu;
  readonly live: MapLiveState = emptyLiveState();
  audio: FlowAudioHooks = {};
  activities: FlowActivityHooks | null = null;
  /** Run once on the title's first tap (a user gesture), after `audio.onFirstGesture`. */
  readonly firstGestureHooks: (() => void)[] = [];
  private minimap: Minimap | null = null;
  private geometry: MapGeometry | null = null;
  private route: RouteFn = straightRoute;
  private routeTarget: { x: number; z: number } | null = null;
  private routeTimer = 0;
  private fullMap: FullMap | null = null;
  private mapView: { x: number; z: number; zoom: number } | null = null;
  private district = '';
  private lastPos: { x: number; z: number; driving: boolean } | null = null;
  private readonly seenVehicles = new Set<number>();
  private blockingCards = 0;
  private lastBigCard = 0;
  private hintsSeen: Record<string, boolean> = {};
  private contextSeen = false;

  constructor(
    private readonly game: Game,
    /** False while something else (the job-failed screen) holds the game paused. */
    private readonly canResume: () => boolean,
  ) {
    this.cards = new Cards(game.overlay);
    try {
      this.hintsSeen = JSON.parse(localStorage.getItem(HINTS_KEY) ?? '{}') as Record<string, boolean>;
    } catch {
      this.hintsSeen = {};
    }
    this.menu = new PauseMenu(game.overlay, {
      settings: this.settingsHooks(),
      onOpen: () => game.setPaused(true),
      onClose: () => this.resumeIfClear(),
      mountMap: (host) => this.mountMap(host),
      jobs: () => this.jobsView(),
      stats: () => this.statsRows(),
      credits: () => game.saves.current.credits,
      onRestartJob: () => game.restartJob(),
      onWalkAway: () => game.walkAway(),
    });
    this.menu.inJob = () => !!game.director?.active;
  }

  /** Call once the world exists (after Game.init has built the sim). */
  init(): void {
    this.setGeometry(geometryFromMap(this.game.content.sim.map as unknown as Parameters<typeof geometryFromMap>[0]));
    // GPS along the road graph.
    const roads = this.game.world.roads;
    this.setRouteFn((ax, az, bx, bz) => roads.route(ax, az, bx, bz));
  }

  /** Swap in new map geometry (the generated city provides its own adapter). Rebuilds the minimap. */
  setGeometry(geom: MapGeometry): void {
    this.geometry = geom;
    this.minimap?.root.remove();
    this.minimap = new Minimap(this.game.overlay, geom);
    this.minimap.rotate = this.game.settings.minimapRotate;
    this.minimap.onTap = () => this.menu.open('map');
    this.district = '';
    this.mapView = null;
  }

  /** Inject the GPS route function (the sim's road graph). Until then routes are straight lines. */
  setRouteFn(fn: RouteFn): void {
    this.route = fn;
    this.routeTarget = null;
  }

  /** The map's geometry (landmark labels can be renamed in place; the maps redraw them). */
  get mapGeometry(): MapGeometry | null {
    return this.geometry;
  }

  /** Hold the game paused behind a panel (the shop); call the returned function to let go. */
  hold(): () => void {
    this.blockingCards++;
    this.game.setPaused(true);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.blockingCards--;
      this.resumeIfClear();
    };
  }

  /** True while the pause menu or a blocking card holds the game. */
  get blocking(): boolean {
    return this.menu.isOpen || this.blockingCards > 0;
  }

  setWaypoint(p: { x: number; z: number } | null): void {
    this.live.waypoint = p;
    this.routeTarget = null;
    this.refreshRoute(true);
    this.fullMap?.invalidate();
  }

  private settingsHooks(): SettingsPanelHooks {
    const g = this.game;
    return {
      settings: g.settings,
      onChange: (s) => {
        storeSettings(s);
        g.input.touch.setScheme(s.scheme);
        if (this.minimap) this.minimap.rotate = s.minimapRotate;
        g.onSettingsChanged?.(s);
      },
      onEditLayout: (on) => g.input.touch.setEditing(on),
      onResetLayout: () => g.input.touch.resetLayout(),
      info: () => g.perfLine(),
      onTestSound: () => (this.audio.onTestSound ? this.audio.onTestSound() : g.sound.audio.ui('pickup')),
      ...g.sound.menuHooks(),
    };
  }

  private resumeIfClear(): void {
    if (!this.menu.isOpen && this.blockingCards === 0 && this.canResume()) this.game.setPaused(false);
  }

  // ---------------------------------------------------------------- title

  /** Title screen; resolves after Continue or New game. New game wipes the save. */
  async title(status: () => string): Promise<TitleChoice> {
    const g = this.game;
    const s = g.saves.current;
    const exists = s.savedAt !== new Date(0).toISOString() || s.credits > 0 || s.completedMissions.length > 0;
    const choice = await showTitle(g.overlay, {
      status,
      save: { exists, summary: `${s.credits.toLocaleString('en-GB')} cr · ${s.completedMissions.length} jobs · ${formatDuration(s.stats.playSeconds)}` },
      onFirstGesture: () => {
        this.audio.onFirstGesture?.();
        for (const f of this.firstGestureHooks) f();
      },
      settings: { ...this.settingsHooks(), onEditLayout: undefined },
      version: 'Vey City · early access',
    });
    if (choice === 'new') {
      g.saves.current = newSave();
      this.hintsSeen = {};
      this.storeHints();
      g.saves.save().catch((err: unknown) => console.warn('Could not write the new save', err));
    }
    return choice;
  }

  /** First steps for a new player, once per save. */
  welcome(): void {
    this.hintOnce('welcome', 'Drag on the left of the screen to move. Find a glowing payphone to take a job.', 'stick', 9);
  }

  private hintOnce(id: string, text: string, control?: string, seconds = 7): void {
    if (this.hintsSeen[id]) return;
    this.hintsSeen[id] = true;
    this.storeHints();
    this.game.hud.showHint(text, control, seconds);
  }

  private storeHints(): void {
    try {
      localStorage.setItem(HINTS_KEY, JSON.stringify(this.hintsSeen));
    } catch {
      /* hints repeat next session: harmless */
    }
  }

  // ---------------------------------------------------------------- missions

  missionStarted(m: Mission): void {
    this.cards.missionStart({ crew: m.faction, title: m.title, subtitle: `${m.budgetMinutes}-minute job` });
  }

  /** Job done: the summary card (pauses until Continue). The bot skips it. */
  missionCompleted(r: MissionResult): void {
    const g = this.game;
    const w = g.world;
    const pv = w.player.vehicle;
    const health = pv ? w.vehicleHealth(pv) : w.playerCtl.hp / w.playerCtl.maxHp;
    if (g.bot) return;
    this.blockingCards++;
    g.setPaused(true);
    void this.cards
      .missionComplete({
        title: r.mission.title,
        crew: r.mission.faction,
        seconds: r.seconds,
        damage: Math.max(0, Math.min(1, 1 - health)),
        pay: r.mission.rewards.credits,
        respect: Object.entries(r.mission.rewards.rep).map(([crew, delta]) => ({ crew, delta })),
      })
      .then(() => {
        this.blockingCards--;
        this.resumeIfClear();
      });
  }

  // ---------------------------------------------------------------- death / arrest

  /** FLATLINED card. The sim keeps running underneath (the respawn happens on its own). */
  flatlined(card?: Partial<BigCard>): boolean {
    return this.big({ title: 'FLATLINED', subtitle: 'Your vitals hit zero', lines: [], ...card }, 'flatlined');
  }

  /** BOOKED card (arrest). */
  booked(card?: Partial<BigCard>): boolean {
    return this.big({ title: 'BOOKED', subtitle: 'The precinct processed you', lines: [], ...card }, 'booked');
  }

  /** Shows the card unless one was shown a moment ago (a death can arrive as two events). */
  private big(card: BigCard, tone: 'flatlined' | 'booked'): boolean {
    const now = performance.now();
    if (now - this.lastBigCard < 2500) return false;
    this.lastBigCard = now;
    void this.cards.big(card, tone);
    return true;
  }

  /** Stats, cards and hints from sim events. Call for every event, after the game's own handling. */
  onSimEvent(e: SimEvent): void {
    const g = this.game;
    const st = g.saves.current.stats;
    const w = g.world;
    const type = (e as { type: string }).type;
    if (e.type === 'enteredVehicle') {
      if (!this.seenVehicles.has(e.vehicleId)) {
        this.seenVehicles.add(e.vehicleId);
        st.carsStolen++;
      }
      this.hintOnce('drive', 'Push the stick the way you want to go. Hold DRIFT to slide round corners.', 'handbrake', 7);
    } else if (e.type === 'vehicleDestroyed') {
      if (e.vehicleId === w.player.vehicle?.id) st.carsWrecked++;
    } else if (e.type === 'shot') {
      const p = w.player;
      if (Math.hypot(e.x - p.x, e.z - p.z) < 3) st.shotsFired++;
    } else if (e.type === 'playerDied') {
      if (this.flatlined()) st.flatlined++;
    } else if (type === 'playerWasted' || type === 'playerBusted') {
      // Added by the death/arrest work: { penalty?: number } in credits.
      const penalty = (e as { penalty?: number }).penalty;
      if (type === 'playerWasted') {
        if (this.flatlined({ lines: penalty ? [`Clinic bill: −${penalty.toLocaleString('en-GB')} cr`] : [] })) st.flatlined++;
      } else if (this.booked({ lines: penalty ? [`Bail: −${penalty.toLocaleString('en-GB')} cr`] : [] })) st.booked++;
    }
  }

  // ---------------------------------------------------------------- per frame

  update(dt: number): void {
    const g = this.game;
    const w = g.world;
    const mm = this.minimap;
    if (!mm || !this.geometry) return;
    const pv = w.player.vehicle;
    const pc = w.playerCtl;
    const x = pv ? pv.x : pc.x;
    const z = pv ? pv.z : pc.z;
    const s = this.live;
    s.x = x;
    s.z = z;
    s.heading = pv ? pv.yaw : pc.facing;
    s.speed = pv ? Math.hypot(pv.vx, pv.vz) : 0;
    s.heat = w.heat.level;
    s.time = w.time;
    s.police.length = 0;
    for (const v of w.vehicles) {
      if (!v.active || v === pv) continue;
      if (v.role === 'police' || v.role === 'squad') s.police.push({ x: v.x, z: v.z, yaw: v.yaw });
    }
    const d = g.director;
    const r = d.runner;
    s.objective = r && r.state === 'running' ? { x: r.view.targetX, z: r.view.targetZ } : (this.activities?.target() ?? null);
    s.payphones.length = 0;
    if (!d.active) for (const gv of d.givers) s.payphones.push({ x: gv.x, z: gv.z, crew: gv.crew, title: gv.title });
    s.activities.length = 0;
    if (!d.active) this.activities?.markers(s.activities, x, z);
    if (s.waypoint && Math.hypot(s.waypoint.x - x, s.waypoint.z - z) < 12) this.setWaypoint(null);
    this.routeTimer -= dt;
    this.refreshRoute(false);
    mm.update(dt, s);

    // District banner.
    const dist = districtAt(this.geometry, x, z);
    const name = dist?.name ?? '';
    if (name !== this.district) {
      this.district = name;
      mm.setDistrict(name);
      if (dist && !g.input.override) g.hud.showDistrict(dist.name, dist.colour);
    }

    // Lifetime stats (render-rate; teleports are ignored).
    const st = g.saves.current.stats;
    if (!g.isPaused) {
      const lp = this.lastPos;
      if (lp) {
        const step = Math.hypot(x - lp.x, z - lp.z);
        if (step < 30) {
          if (pv && lp.driving) st.distanceDriven += step;
          else if (!pv && !lp.driving) st.distanceWalked += step;
        }
      }
      this.lastPos = { x, z, driving: !!pv };
    }
    if (w.heat.level > st.highestHeat) st.highestHeat = w.heat.level;
    g.hud.setCredits(g.saves.current.credits);

    // First time the context button shows, explain it.
    const ctx = pc.context?.label ?? null;
    if (ctx && !this.contextSeen) {
      this.contextSeen = true;
      this.hintOnce('context', `Tap ${ctx} to use what is in front of you.`, 'context', 6);
    }
  }

  private refreshRoute(force: boolean): void {
    const s = this.live;
    const target = s.objective ?? s.waypoint;
    if (!target) {
      if (s.route.length) s.route.length = 0;
      this.routeTarget = null;
      return;
    }
    const moved = !this.routeTarget || Math.hypot(this.routeTarget.x - target.x, this.routeTarget.z - target.z) > 1;
    const offRoute = s.route.length < 2 || distanceToRoute(s.route, s.x, s.z) > 10;
    if (!force && !moved && !offRoute && this.routeTimer > 0) return;
    // Straight-line fallback re-anchors often; a road route only when the player strays or every few seconds.
    this.routeTimer = this.route === straightRoute ? 0.25 : 3;
    this.routeTarget = { x: target.x, z: target.z };
    let pts = s.route;
    try {
      pts = this.route(s.x, s.z, target.x, target.z);
    } catch (err) {
      console.warn('Route failed, using a straight line', err);
      pts = straightRoute(s.x, s.z, target.x, target.z);
    }
    s.route.length = 0;
    for (const p of pts) s.route.push(p);
  }

  private mountMap(host: HTMLElement): () => void {
    if (!this.minimap) return () => undefined;
    const fm = new FullMap(host, this.minimap.prepared, this.live, { onWaypoint: (p) => this.setWaypoint(p) });
    if (this.mapView) fm.setView({ ...this.mapView, x: this.live.x, z: this.live.z });
    this.fullMap = fm;
    return () => {
      this.mapView = fm.view;
      fm.destroy();
      if (this.fullMap === fm) this.fullMap = null;
    };
  }

  private jobsView(): JobsView {
    const g = this.game;
    const d = g.director;
    const r = d.runner;
    const save = g.saves.current;
    let active: JobsView['active'] = null;
    if (r && d.active) {
      const t = r.view.timeLeft;
      active = {
        title: r.mission.title,
        crew: r.mission.faction,
        objective: r.view.text,
        timer: t === null ? null : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} left`,
      };
    }
    return {
      active,
      respect: save.respect,
      available: [
        ...d.givers.map((gv) => ({ title: gv.title, crew: gv.crew, done: false })),
        ...d.missions.filter((m) => save.completedMissions.includes(m.id)).map((m) => ({ title: m.title, crew: m.faction, done: true })),
      ],
      ...g.economy?.exportsView(),
    };
  }

  private statsRows(): { label: string; value: string }[] {
    const st = this.game.saves.current.stats;
    const km = (m: number): string => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
    const n = (v: number): string => v.toLocaleString('en-GB');
    return [
      { label: 'Time on the streets', value: formatDuration(st.playSeconds) },
      { label: 'Jobs done', value: n(st.missionsPassed) },
      { label: 'Credits earned', value: `${n(st.creditsEarned)} cr` },
      { label: 'Distance driven', value: km(st.distanceDriven) },
      { label: 'Distance on foot', value: km(st.distanceWalked) },
      { label: 'Cars taken', value: n(st.carsStolen) },
      { label: 'Cars wrecked', value: n(st.carsWrecked) },
      { label: 'Shots fired', value: n(st.shotsFired) },
      { label: 'Highest HEAT', value: `${st.highestHeat} / 5` },
      { label: 'Flatlined', value: n(st.flatlined) },
      { label: 'Booked', value: n(st.booked) },
      { label: 'Credits spent', value: `${n(st.creditsSpent)} cr` },
      { label: 'Exports delivered', value: n(st.exportsDelivered) },
      ...(this.activities?.stats() ?? []),
    ];
  }
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${m}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`;
}
