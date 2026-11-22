import type { MapContent, VehiclesContent } from '@neonheat/sim';
import type { Dialogue, Mission, MissionEvent, Squads } from './schema';

export interface LintContext {
  map: MapContent;
  vehicles: VehiclesContent;
  squads: Squads;
  dialogue: Dialogue;
}

export interface LintIssue {
  mission: string;
  path: string;
  message: string;
}

/**
 * Walkability grid over the block: true where something of the given
 * clearance radius fits (inside the walls, outside every building).
 */
export function walkGrid(map: MapContent, clearance: number, cell = 2): { cell: number; n: number; half: number; open: Uint8Array } {
  const half = map.size[0] / 2;
  const n = Math.ceil(map.size[0] / cell);
  const open = new Uint8Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    for (let ix = 0; ix < n; ix++) {
      const x = -half + (ix + 0.5) * cell;
      const z = -half + (iz + 0.5) * cell;
      let ok = Math.abs(x) < half - clearance && Math.abs(z) < half - clearance;
      for (const b of map.buildings) {
        if (!ok) break;
        if (Math.abs(x - b.x) < b.w / 2 + clearance && Math.abs(z - b.z) < b.d / 2 + clearance) ok = false;
      }
      open[iz * n + ix] = ok ? 1 : 0;
    }
  }
  return { cell, n, half, open };
}

/** Flood fill from a start point; returns a reachability lookup. */
export function reachableFrom(grid: ReturnType<typeof walkGrid>, x: number, z: number): (x: number, z: number) => boolean {
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
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = cx + dx;
      const nz = cz + dz;
      if (nx < 0 || nz < 0 || nx >= n || nz >= n) continue;
      const ni = nz * n + nx;
      if (!seen[ni] && open[ni]) {
        seen[ni] = 1;
        q.push(ni);
      }
    }
  }
  return (px, pz) => {
    const i = idx(px, pz);
    return i >= 0 && seen[i] === 1;
  };
}

/** Schema-level validity is Zod's job; this checks references and reachability against the world. */
export function lintMission(m: Mission, ctx: LintContext): LintIssue[] {
  const issues: LintIssue[] = [];
  const add = (path: string, message: string): void => void issues.push({ mission: m.id, path, message });
  const start = ctx.map.markers['player_start']?.pos ?? [0, 0, 0];
  const onFoot = reachableFrom(walkGrid(ctx.map, 0.5), start[0], start[2]);
  const byCar = reachableFrom(walkGrid(ctx.map, 1.6), start[0], start[2]);

  const pos = (ref: string, path: string): [number, number] | null => {
    const [kind, id] = ref.split(':') as [string, string];
    if (kind === 'marker') {
      const mk = ctx.map.markers[id];
      if (!mk) return add(path, `unknown marker "${id}"`), null;
      return [mk.pos[0], mk.pos[2]];
    }
    const sp = ctx.map.spawns[id];
    if (!sp) return add(path, `unknown spawn "${id}"`), null;
    if (!(sp.variant in ctx.vehicles.variants)) add(path, `spawn "${id}" uses unknown vehicle variant "${sp.variant}"`);
    return [sp.pos[0], sp.pos[2]];
  };

  const checkEvents = (events: MissionEvent[] | undefined, path: string): void => {
    events?.forEach((e, i) => {
      if (e.do === 'dialogue' && !(e.line in ctx.dialogue)) add(`${path}[${i}]`, `unknown dialogue line "${e.line}"`);
      if (e.do === 'spawnSquad') {
        const sq = ctx.squads[e.squad];
        if (!sq) add(`${path}[${i}]`, `unknown squad "${e.squad}"`);
        else if (!(sq.variant in ctx.vehicles.variants)) add(`${path}[${i}]`, `squad "${e.squad}" uses unknown variant "${sq.variant}"`);
      }
      if (e.do === 'setHeat' && e.value > 3) add(`${path}[${i}]`, 'Phase 0 caps HEAT at 3');
    });
  };

  const [gx, , gz] = m.giver.pos;
  if (!onFoot(gx, gz)) add('giver.pos', 'payphone is not reachable on foot from the player start');

  m.objectives.forEach((o, i) => {
    const base = `objectives[${i}](${o.id})`;
    checkEvents(o.onStart, `${base}.onStart`);
    checkEvents(o.onComplete, `${base}.onComplete`);
    checkEvents(o.onFail, `${base}.onFail`);
    if (o.type === 'reach') {
      const p = pos(o.target, `${base}.target`);
      if (p && !onFoot(p[0], p[1])) add(`${base}.target`, 'target is not reachable');
    } else if (o.type === 'hack') {
      const p = pos(o.target, `${base}.target`);
      if (p && !onFoot(p[0], p[1])) add(`${base}.target`, 'hack target is not reachable on foot');
    } else {
      const v = pos(o.vehicle, `${base}.vehicle`);
      const t = pos(o.target, `${base}.target`);
      if (v && !byCar(v[0], v[1])) add(`${base}.vehicle`, 'vehicle spawn is boxed in: a car cannot drive out');
      if (t && !byCar(t[0], t[1])) add(`${base}.target`, 'drop-off is not reachable by car');
      if (o.timeLimitSec !== undefined && o.timeLimitSec > m.budgetMinutes * 60) add(`${base}.timeLimitSec`, 'time limit exceeds the mission budget');
    }
  });
  return issues;
}
