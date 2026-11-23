import type { MapContent, VehiclesContent } from '@neonheat/sim';
import { missionOrder, prerequisitesMet, type MissionProgress } from './director';
import { markerPos, resolveActorDef, resolveSpawnDef, splitRef } from './refs';
import type { Crews, Dialogue, FailCondition, Mission, MissionEvent, Objective, Squads, VehicleReq } from './schema';

export interface LintContext {
  map: MapContent;
  vehicles: VehiclesContent;
  squads: Squads;
  dialogue: Dialogue;
  /** Known crews; missions and actors must use one of these (or "civilian"). */
  crews?: Crews;
  /** Highest HEAT level a mission may set (the HEAT config's maxLevel). */
  heatMax?: number;
}

export interface LintIssue {
  mission: string;
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface WalkGrid {
  cell: number;
  n: number;
  half: number;
  open: Uint8Array;
}

/**
 * Walkability grid over the map: true where something of the given clearance
 * radius fits (inside the walls, outside every building). Buildings are
 * rasterised, so this stays fast on a big city.
 */
export function walkGrid(map: MapContent, clearance: number, cell = 2): WalkGrid {
  const half = map.size[0] / 2;
  const n = Math.ceil(map.size[0] / cell);
  const open = new Uint8Array(n * n);
  const inner = half - clearance;
  for (let iz = 0; iz < n; iz++) {
    const z = -half + (iz + 0.5) * cell;
    for (let ix = 0; ix < n; ix++) {
      const x = -half + (ix + 0.5) * cell;
      open[iz * n + ix] = Math.abs(x) < inner && Math.abs(z) < inner ? 1 : 0;
    }
  }
  const toCell = (v: number): number => Math.floor((v + half) / cell - 0.5);
  for (const b of map.buildings) {
    const hx = b.w / 2 + clearance;
    const hz = b.d / 2 + clearance;
    const x0 = Math.max(0, toCell(b.x - hx));
    const x1 = Math.min(n - 1, toCell(b.x + hx) + 1);
    const z0 = Math.max(0, toCell(b.z - hz));
    const z1 = Math.min(n - 1, toCell(b.z + hz) + 1);
    for (let iz = z0; iz <= z1; iz++) {
      const z = -half + (iz + 0.5) * cell;
      if (Math.abs(z - b.z) >= hz) continue;
      for (let ix = x0; ix <= x1; ix++) {
        const x = -half + (ix + 0.5) * cell;
        if (Math.abs(x - b.x) < hx) open[iz * n + ix] = 0;
      }
    }
  }
  return { cell, n, half, open };
}

/** Flood fill from a start point; returns a reachability lookup (nearest open cell within 2 cells counts). */
export function reachableFrom(grid: WalkGrid, x: number, z: number): (x: number, z: number) => boolean {
  const { cell, n, half, open } = grid;
  const idx = (px: number, pz: number): number => {
    const ix = Math.floor((px + half) / cell);
    const iz = Math.floor((pz + half) / cell);
    return ix < 0 || iz < 0 || ix >= n || iz >= n ? -1 : iz * n + ix;
  };
  const seen = new Uint8Array(n * n);
  const start = idx(x, z);
  const q: number[] = [];
  if (start >= 0 && open[start]) {
    seen[start] = 1;
    q.push(start);
  }
  for (let i = 0; i < q.length; i++) {
    const c = q[i]!;
    const cx = c % n;
    const cz = (c - cx) / n;
    if (cx > 0 && !seen[c - 1] && open[c - 1]) (seen[c - 1] = 1), q.push(c - 1);
    if (cx < n - 1 && !seen[c + 1] && open[c + 1]) (seen[c + 1] = 1), q.push(c + 1);
    if (cz > 0 && !seen[c - n] && open[c - n]) (seen[c - n] = 1), q.push(c - n);
    if (cz < n - 1 && !seen[c + n] && open[c + n]) (seen[c + n] = 1), q.push(c + n);
  }
  return (px, pz) => {
    const i = idx(px, pz);
    return i >= 0 && seen[i] === 1;
  };
}

interface Reach {
  onFoot: (x: number, z: number) => boolean;
  byCar: (x: number, z: number) => boolean;
}

const reachCache = new WeakMap<MapContent, Reach>();

function reachOf(map: MapContent): Reach {
  let r = reachCache.get(map);
  if (!r) {
    const start = markerPos(map, 'player_start') ?? { x: 0, z: 0 };
    r = { onFoot: reachableFrom(walkGrid(map, 0.5), start.x, start.z), byCar: reachableFrom(walkGrid(map, 1.6), start.x, start.z) };
    reachCache.set(map, r);
  }
  return r;
}

/** Rough speeds for the duration estimate (m/s). */
const DRIVE_SPEED = 14;
const WALK_SPEED = 5;

/** Schema-level validity is Zod's job; this checks references, objective fields and reachability against the world. */
export function lintMission(m: Mission, ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (path: string, message: string, severity: 'error' | 'warning' = 'error'): void => void issues.push({ mission: m.id, path, message, severity });
  const { onFoot, byCar } = reachOf(ctx.map);
  const crews = ctx.crews;
  const heatMax = ctx.heatMax ?? 5;
  const usedSpawns = new Set<string>();
  const usedActors = new Set<string>();
  const boarded = new Set<string>();

  if (crews && !(m.faction in crews)) add('faction', `unknown crew "${m.faction}"`);

  const markerAt = (ref: string, path: string): [number, number] | null => {
    const [, id] = splitRef(ref);
    const p = markerPos(ctx.map, id);
    if (!p) return add(path, `unknown marker "${id}"`), null;
    return [p.x, p.z];
  };

  // Mission-local spawns and actors.
  for (const [id, s] of Object.entries(m.spawns ?? {})) {
    const path = `spawns.${id}`;
    if (!(s.variant in ctx.vehicles.variants)) add(path, `unknown vehicle variant "${s.variant}"`);
    if (markerAt(s.at, `${path}.at`)) {
      const r = resolveSpawnDef(ctx.map, m, `spawn:${id}`)!;
      if (!byCar(r.x, r.z)) add(path, 'spawn point is boxed in: a car cannot drive out');
    }
    if (id in ctx.map.spawns) add(path, `shadows map spawn "${id}"`, 'warning');
  }
  for (const [id, a] of Object.entries(m.actors ?? {})) {
    const path = `actors.${id}`;
    if (crews && a.faction !== 'civilian' && !(a.faction in crews)) add(path, `unknown crew "${a.faction}"`);
    if (markerAt(a.at, `${path}.at`)) {
      const r = resolveActorDef(ctx.map, m, `actor:${id}`)!;
      if (!onFoot(r.x, r.z)) add(path, 'actor stands somewhere unreachable');
    }
  }

  /** Position of any reference (checking it exists). */
  const pos = (ref: string, path: string): [number, number] | null => {
    const [kind, id] = splitRef(ref);
    if (kind === 'marker') return markerAt(ref, path);
    if (kind === 'actor') {
      usedActors.add(id);
      const a = m.actors?.[id];
      if (!a) return add(path, `unknown actor "${id}" (actors are declared in the mission)`), null;
      const r = resolveActorDef(ctx.map, m, ref);
      return r ? [r.x, r.z] : null;
    }
    usedSpawns.add(id);
    const local = m.spawns?.[id];
    if (local) {
      const r = resolveSpawnDef(ctx.map, m, ref);
      return r ? [r.x, r.z] : null;
    }
    const sp = ctx.map.spawns[id];
    if (!sp) return add(path, `unknown spawn "${id}"`), null;
    if (!(sp.variant in ctx.vehicles.variants)) add(path, `spawn "${id}" uses unknown vehicle variant "${sp.variant}"`);
    return [sp.pos[0], sp.pos[2]];
  };
  const needCar = (ref: string, path: string, what: string): [number, number] | null => {
    const p = pos(ref, path);
    if (p && !byCar(p[0], p[1])) add(path, `${what} is not reachable by car`);
    return p;
  };
  const needFoot = (ref: string, path: string, what: string): [number, number] | null => {
    const p = pos(ref, path);
    if (p && !onFoot(p[0], p[1])) add(path, `${what} is not reachable on foot`);
    return p;
  };
  const reachWith = (req: VehicleReq | undefined, ref: string, path: string, what: string): [number, number] | null => {
    if (req && req !== 'none') {
      if (req !== 'any') pos(req, `${path}.vehicle`);
      return needCar(ref, path, what);
    }
    return needFoot(ref, path, what);
  };

  const checkEvents = (events: MissionEvent[] | undefined, path: string): void => {
    events?.forEach((e, i) => {
      const p = `${path}[${i}]`;
      switch (e.do) {
        case 'dialogue':
          if (!(e.line in ctx.dialogue)) add(p, `unknown dialogue line "${e.line}"`);
          break;
        case 'spawnSquad': {
          const sq = ctx.squads[e.squad];
          if (!sq) add(p, `unknown squad "${e.squad}"`);
          else if (!(sq.variant in ctx.vehicles.variants)) add(p, `squad "${e.squad}" uses unknown variant "${sq.variant}"`);
          break;
        }
        case 'setHeat':
          if (e.value > heatMax) add(p, `HEAT tops out at ${heatMax} in the current HEAT config, so this is clamped`, 'warning');
          break;
        case 'spawn':
        case 'despawn':
          e.refs.forEach((r, j) => pos(r, `${p}.refs[${j}]`));
          break;
        case 'aggro':
          e.refs.forEach((r, j) => {
            pos(r, `${p}.refs[${j}]`);
            const a = m.actors?.[splitRef(r)[1]];
            if (a && !a.hostile) add(`${p}.refs[${j}]`, `actor "${r}" is not hostile, so aggro makes it hostile`, 'warning');
          });
          break;
        case 'drive':
          pos(e.vehicle, `${p}.vehicle`);
          e.route?.forEach((r, j) => needCar(r, `${p}.route[${j}]`, 'route point'));
          if (e.target && e.target !== 'player') pos(e.target, `${p}.target`);
          if (e.mode === 'route' && !e.route) add(p, 'a route drive needs a route');
          if (e.mode === 'ram' && !e.target) add(p, 'a ram drive needs a target');
          break;
        case 'board':
          e.actors.forEach((r, j) => {
            pos(r, `${p}.actors[${j}]`);
            boarded.add(r);
          });
          break;
        case 'alight':
          e.actors.forEach((r, j) => pos(r, `${p}.actors[${j}]`));
          if (e.at) pos(e.at, `${p}.at`);
          break;
        case 'goTo':
          pos(e.actor, `${p}.actor`);
          needFoot(e.to, `${p}.to`, 'goTo destination');
          break;
        case 'lock':
          pos(e.vehicle, `${p}.vehicle`);
          break;
        case 'addTrace':
        case 'hint':
          break;
      }
    });
  };
  const checkFail = (conds: FailCondition[] | undefined, path: string): void => {
    conds?.forEach((c, i) => {
      if ('target' in c) pos(c.target, `${path}[${i}].target`);
    });
  };

  if (m.giver.at) {
    const p = markerAt(m.giver.at, 'giver.at');
    if (p && !onFoot(p[0], p[1])) add('giver.at', 'payphone is not reachable on foot from the player start');
    if (!/_payphone_\d+$/.test(m.giver.at)) add('giver.at', 'payphones should use a *_payphone_N marker', 'warning');
  } else if (m.giver.pos) {
    const [gx, , gz] = m.giver.pos;
    if (!onFoot(gx, gz)) add('giver.pos', 'payphone is not reachable on foot from the player start');
    add('giver.pos', 'absolute payphone positions are deprecated: use "at": "marker:<id>"', 'warning');
  }
  checkEvents(m.onStart, 'onStart');
  checkEvents(m.onComplete, 'onComplete');

  // Rough duration: travel between objective targets plus timed waits.
  let last: [number, number] | null = m.giver.at ? (markerPos(ctx.map, splitRef(m.giver.at)[1]) ? [markerPos(ctx.map, splitRef(m.giver.at)[1])!.x, markerPos(ctx.map, splitRef(m.giver.at)[1])!.z] : null) : m.giver.pos ? [m.giver.pos[0], m.giver.pos[2]] : null;
  let seconds = 0;
  const leg = (p: [number, number] | null, speed = DRIVE_SPEED): void => {
    if (!p) return;
    if (last) seconds += (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1])) / speed;
    last = p;
  };

  m.objectives.forEach((o: Objective, i) => {
    const base = `objectives[${i}](${o.id})`;
    checkEvents(o.onStart, `${base}.onStart`);
    checkEvents(o.onComplete, `${base}.onComplete`);
    checkEvents(o.onFail, `${base}.onFail`);
    checkFail(o.failOn, `${base}.failOn`);
    switch (o.type) {
      case 'reach':
        leg(reachWith(o.vehicle, o.target, `${base}.target`, 'target'), o.vehicle === 'none' ? WALK_SPEED : DRIVE_SPEED);
        break;
      case 'hack':
        leg(needFoot(o.target, `${base}.target`, 'hack target'), WALK_SPEED);
        seconds += 12;
        break;
      case 'deliverVehicle': {
        const v = pos(o.vehicle, `${base}.vehicle`);
        if (v && !byCar(v[0], v[1])) add(`${base}.vehicle`, 'vehicle spawn is boxed in: a car cannot drive out');
        leg(v, WALK_SPEED);
        leg(needCar(o.target, `${base}.target`, 'drop-off'));
        break;
      }
      case 'stealVehicle':
        if (o.vehicle) leg(pos(o.vehicle, `${base}.vehicle`), WALK_SPEED);
        o.variants?.forEach((v, j) => {
          if (!(v in ctx.vehicles.variants)) add(`${base}.variants[${j}]`, `unknown vehicle variant "${v}"`);
        });
        seconds += 20;
        break;
      case 'destroyVehicle':
        o.targets.forEach((t, j) => leg(needCar(t, `${base}.targets[${j}]`, 'target')));
        if (o.escapeAt) needCar(o.escapeAt, `${base}.escapeAt`, 'escape point');
        seconds += 15 * o.targets.length;
        break;
      case 'eliminate':
        o.targets.forEach((t, j) => {
          const p = needFoot(t, `${base}.targets[${j}]`, 'target');
          leg(p);
          if (!t.startsWith('actor:')) add(`${base}.targets[${j}]`, 'eliminate targets are actors');
        });
        seconds += 8 * o.targets.length;
        break;
      case 'protect':
        pos(o.target, `${base}.target`);
        if (o.destination) leg(needCar(o.destination, `${base}.destination`, 'escort destination'), 10);
        if (o.durationSec) seconds += o.durationSec;
        break;
      case 'tail':
        pos(o.target, `${base}.target`);
        o.route.forEach((r, j) => leg(needCar(r, `${base}.route[${j}]`, 'route point'), o.speed));
        break;
      case 'chase':
        leg(needCar(o.target, `${base}.target`, 'chase target'));
        seconds += 45;
        break;
      case 'escape':
        seconds += 40;
        break;
      case 'race':
        if (o.vehicle !== 'any' && o.vehicle !== 'none') pos(o.vehicle, `${base}.vehicle`);
        if (o.vehicle === 'none') add(`${base}.vehicle`, 'a race on foot is not supported', 'warning');
        o.checkpoints.forEach((r, j) => leg(needCar(r, `${base}.checkpoints[${j}]`, 'checkpoint'), 20));
        o.opponents?.forEach((r, j) => pos(r, `${base}.opponents[${j}]`));
        break;
      case 'collect':
        o.pickups.forEach((r, j) => leg(reachWith(o.vehicle, r, `${base}.pickups[${j}]`, 'pickup'), o.vehicle === 'none' ? WALK_SPEED : DRIVE_SPEED));
        break;
      case 'wait':
        leg(reachWith(o.vehicle, o.target, `${base}.target`, 'wait zone'));
        seconds += o.durationSec;
        break;
      case 'dropOff':
        leg(needCar(o.target, `${base}.target`, 'drop-off'));
        if (o.vehicle !== 'any' && o.vehicle !== 'none') pos(o.vehicle, `${base}.vehicle`);
        o.passengers?.forEach((r, j) => {
          pos(r, `${base}.passengers[${j}]`);
          if (!boarded.has(r)) add(`${base}.passengers[${j}]`, `passenger "${r}" never boards before this drop-off`);
        });
        break;
      case 'photograph':
        leg(pos(o.target, `${base}.target`));
        seconds += o.holdSec + 5;
        break;
      case 'perform':
        seconds += 4;
        break;
    }
  });

  for (const id of Object.keys(m.spawns ?? {})) if (!usedSpawns.has(id)) add(`spawns.${id}`, 'spawn is never used', 'warning');
  for (const id of Object.keys(m.actors ?? {})) if (!usedActors.has(id)) add(`actors.${id}`, 'actor is never used', 'warning');
  if (seconds > m.budgetMinutes * 60) add('budgetMinutes', `rough estimate ${Math.round(seconds / 60)} min exceeds the ${m.budgetMinutes} min budget`, 'warning');
  return issues;
}

/**
 * Checks across all missions: prerequisites point at real missions, there are
 * no cycles, every mission can be reached from a new game, chains are ordered,
 * and there is a story thread that starts with no prerequisites.
 */
export function lintCampaign(missions: readonly Mission[], crews?: Crews): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (mission: string, path: string, message: string, severity: 'error' | 'warning' = 'error'): void => void issues.push({ mission, path, message, severity });
  const byId = new Map(missions.map((m) => [m.id, m]));
  for (const m of missions) {
    for (const id of m.prerequisites?.missions ?? []) if (!byId.has(id)) add(m.id, 'prerequisites.missions', `unknown mission "${id}"`);
    for (const crew of Object.keys(m.prerequisites?.respect ?? {})) if (crews && !(crew in crews)) add(m.id, 'prerequisites.respect', `unknown crew "${crew}"`);
    for (const crew of Object.keys(m.rewards.rep)) if (crews && !(crew in crews)) add(m.id, 'rewards.rep', `unknown crew "${crew}"`);
  }
  // Cycles.
  const state = new Map<string, 1 | 2>();
  const visit = (id: string, stack: string[]): void => {
    const s = state.get(id);
    if (s === 2) return;
    if (s === 1) {
      add(id, 'prerequisites', `prerequisite cycle: ${[...stack.slice(stack.indexOf(id)), id].join(' -> ')}`);
      return;
    }
    state.set(id, 1);
    for (const p of byId.get(id)?.prerequisites?.missions ?? []) if (byId.has(p)) visit(p, [...stack, id]);
    state.set(id, 2);
  };
  for (const m of missions) visit(m.id, []);
  // Reachable from a new game: play everything available, in the director's order, until stuck.
  const progress: { completed: string[]; respect: Record<string, number> } = { completed: [], respect: {} };
  for (;;) {
    const next = missions.filter((m) => !progress.completed.includes(m.id) && prerequisitesMet(m, progress as MissionProgress)).sort(missionOrder)[0];
    if (!next) break;
    progress.completed.push(next.id);
    for (const [c, v] of Object.entries(next.rewards.rep)) progress.respect[c] = (progress.respect[c] ?? 0) + v;
  }
  for (const m of missions) if (!progress.completed.includes(m.id)) add(m.id, 'prerequisites', 'cannot be reached from a new game (prerequisites never met)');
  // Chains.
  const chains = new Map<string, Mission[]>();
  for (const m of missions) {
    if (m.chain === undefined) continue;
    const list = chains.get(m.faction) ?? [];
    list.push(m);
    chains.set(m.faction, list);
  }
  for (const [crew, list] of chains) {
    const seen = new Map<number, string>();
    for (const m of list) {
      const other = seen.get(m.chain!);
      if (other) add(m.id, 'chain', `chain position ${m.chain} is also used by ${other} (${crew})`);
      seen.set(m.chain!, m.id);
    }
    for (const m of list) {
      if (m.chain! === 0) continue;
      const prev = list.find((x) => x.chain === m.chain! - 1);
      if (prev && !(m.prerequisites?.missions ?? []).includes(prev.id)) add(m.id, 'chain', `chain position ${m.chain} should require ${prev.id}`, 'warning');
    }
  }
  const story = missions.filter((m) => m.story);
  if (missions.length > 1 && story.length === 0) add('*', 'story', 'no story missions', 'warning');
  if (story.length > 0 && !story.some((m) => !m.prerequisites?.missions?.length)) add('*', 'story', 'the story thread has no starting mission (one with no mission prerequisites)');
  return issues;
}
