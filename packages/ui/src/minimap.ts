import { crewById, drawActivity, drawCrewMark, drawLandmark, type ActivityIconKind } from './icons';
import type { MapGeometry, RoutePoint } from './map-geometry';
import { drawObjective, drawPlayerArrow, drawWaypoint, paintMap, prepareMap, strokeRoute, type PreparedMap } from './map-paint';

/**
 * What the map shows that changes every frame. The app fills one of these and
 * hands it to both the minimap and the full map; no allocation per frame.
 * Headings use the sim's convention: radians, 0 = +z (south, screen down), π/2 = +x (east).
 */
export interface MapLiveState {
  x: number;
  z: number;
  heading: number;
  /** Player speed in m/s; the minimap zooms out with it. */
  speed: number;
  heat: number;
  police: { x: number; z: number; yaw: number }[];
  objective: { x: number; z: number } | null;
  waypoint: { x: number; z: number } | null;
  route: RoutePoint[];
  payphones: { x: number; z: number; crew: string; title: string }[];
  /** Side activities (rampages, ramps, races, fares; shards only near the player, minimap only). */
  activities: ActivityMarker[];
  time: number;
}

export interface ActivityMarker {
  x: number;
  z: number;
  kind: ActivityIconKind;
  /** Completed (a ramp's unique jump, a race won, a rampage passed): drawn dimmed. */
  done: boolean;
  title: string;
}

export function emptyLiveState(): MapLiveState {
  return { x: 0, z: 0, heading: 0, speed: 0, heat: 0, police: [], objective: null, waypoint: null, route: [], payphones: [], activities: [], time: 0 };
}

/** HEAT level at which police vision cones appear on the maps. */
export const CONE_HEAT = 3;
const CONE_RANGE = 34;
const CONE_HALF = Math.PI / 6;

export interface MinimapOptions {
  /** CSS pixels across. */
  size?: number;
  dpr?: number;
  /** Metres across at rest, and at full speed. */
  spanMin?: number;
  spanMax?: number;
  /** Speed (m/s) at which the minimap is fully zoomed out. */
  zoomSpeed?: number;
}

/**
 * Circular minimap. The static city is painted once to an offscreen canvas;
 * each redraw (about 30 Hz) blits a window of it, optionally rotated so the
 * player's heading is up, then draws the route, police with vision cones at
 * HEAT 3+, crew payphones, the objective and the player arrow. Tap to open the
 * full map (`onTap`).
 */
export class Minimap {
  readonly root: HTMLElement;
  /** Rotate the map so the player's heading points up. */
  rotate = false;
  onTap: (() => void) | null = null;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly layer: HTMLCanvasElement;
  private readonly px: number;
  private readonly layerScale: number;
  private readonly half: [number, number];
  private readonly spanMin: number;
  private readonly spanMax: number;
  private readonly zoomSpeed: number;
  private span: number;
  private acc = 1;
  private readonly districtEl: HTMLElement;
  private readonly compass: HTMLElement;
  private compassAngle = NaN;
  private readonly cssSize: number;
  readonly prepared: PreparedMap;

  constructor(parent: HTMLElement, geom: MapGeometry, opts: MinimapOptions = {}) {
    const css = opts.size ?? 116;
    const dpr = opts.dpr ?? Math.min(3, globalThis.devicePixelRatio || 1);
    this.spanMin = opts.spanMin ?? 140;
    this.spanMax = opts.spanMax ?? 280;
    this.zoomSpeed = opts.zoomSpeed ?? 34;
    this.span = this.spanMin;
    this.cssSize = css;
    this.root = document.createElement('div');
    this.root.className = 'nh-minimap';
    this.root.style.setProperty('--mm-size', `${css}px`);
    this.root.setAttribute('role', 'button');
    this.root.setAttribute('aria-label', 'Open the map');
    this.root.innerHTML = `<div class="nh-minimap__disc"><canvas></canvas></div><div class="nh-minimap__n">N</div><div class="nh-minimap__district"></div>`;
    const canvas = this.root.querySelector('canvas')!;
    this.districtEl = this.root.querySelector('.nh-minimap__district') as HTMLElement;
    this.compass = this.root.querySelector('.nh-minimap__n') as HTMLElement;
    this.px = Math.round(css * dpr);
    canvas.width = canvas.height = this.px;
    this.root.addEventListener('click', () => this.onTap?.());
    parent.appendChild(this.root);
    this.ctx = canvas.getContext('2d')!;
    this.prepared = prepareMap(geom);
    // The static layer: sharp at rest, capped so a big city stays within mobile canvas limits.
    const maxDim = Math.max(geom.size[0], geom.size[1]);
    this.layerScale = Math.min(this.px / this.spanMin, 2048 / maxDim);
    this.half = [geom.size[0] / 2, geom.size[1] / 2];
    this.layer = document.createElement('canvas');
    this.layer.width = Math.ceil(geom.size[0] * this.layerScale);
    this.layer.height = Math.ceil(geom.size[1] * this.layerScale);
    const g = this.layer.getContext('2d')!;
    g.setTransform(this.layerScale, 0, 0, this.layerScale, this.half[0] * this.layerScale, this.half[1] * this.layerScale);
    paintMap(g, this.prepared, this.layerScale, { districts: true });
  }

  /** The district name shown under the minimap. */
  setDistrict(name: string): void {
    if (this.districtEl.textContent !== name) this.districtEl.textContent = name;
  }

  update(dt: number, s: MapLiveState): void {
    // Zoom follows speed smoothly, even between redraws.
    const t = Math.min(1, Math.abs(s.speed) / this.zoomSpeed);
    const target = this.spanMin + (this.spanMax - this.spanMin) * t * t;
    this.span += (target - this.span) * Math.min(1, dt * 2.5);
    this.acc += dt;
    if (this.acc < 1 / 30) return;
    this.acc = 0;
    const c = this.ctx;
    const n = this.px;
    const k = n / this.span; // px per metre on screen
    const ls = this.layerScale;
    const angle = Math.PI - s.heading; // player's direction as a canvas angle (0 = up)
    const rot = this.rotate ? -angle : 0;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const toPx = (wx: number, wz: number): [number, number] => {
      const dx = (wx - s.x) * k;
      const dz = (wz - s.z) * k;
      return [n / 2 + dx * cos - dz * sin, n / 2 + dx * sin + dz * cos];
    };
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, n, n);
    c.fillStyle = '#05060e';
    c.fillRect(0, 0, n, n);
    // Static layer: translate so the player is at the centre, rotate, scale layer px to screen px.
    c.save();
    c.translate(n / 2, n / 2);
    c.rotate(rot);
    c.scale(k / ls, k / ls);
    c.translate(-(s.x + this.half[0]) * ls, -(s.z + this.half[1]) * ls);
    c.imageSmoothingEnabled = true;
    // Blit only the window around the player (a rotated view needs the square's diagonal).
    const lw = this.layer.width;
    const lh = this.layer.height;
    const r = Math.ceil((this.span / 2) * ls * (this.rotate ? 1.42 : 1.02));
    const cx = (s.x + this.half[0]) * ls;
    const cz = (s.z + this.half[1]) * ls;
    const sx0 = Math.max(0, Math.floor(cx - r));
    const sz0 = Math.max(0, Math.floor(cz - r));
    const sx1 = Math.min(lw, Math.ceil(cx + r));
    const sz1 = Math.min(lh, Math.ceil(cz + r));
    if (sx1 > sx0 && sz1 > sz0) c.drawImage(this.layer, sx0, sz0, sx1 - sx0, sz1 - sz0, sx0, sz0, sx1 - sx0, sz1 - sz0);
    c.restore();

    const dot = n / 52; // base marker size in px
    strokeRoute(c, s.route, toPx, dot * 0.9, s.time);

    if (s.heat >= CONE_HEAT) {
      for (const p of s.police) {
        const [cx, cy] = toPx(p.x, p.z);
        if (cx < -n || cy < -n || cx > 2 * n || cy > 2 * n) continue;
        const a = Math.atan2(Math.cos(p.yaw), Math.sin(p.yaw)) + rot;
        const g = c.createRadialGradient(cx, cy, 0, cx, cy, CONE_RANGE * k);
        g.addColorStop(0, 'rgba(255, 51, 85, 0.45)');
        g.addColorStop(1, 'rgba(255, 51, 85, 0)');
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(cx, cy);
        c.arc(cx, cy, CONE_RANGE * k, a - CONE_HALF, a + CONE_HALF);
        c.closePath();
        c.fill();
      }
    }
    const blink = Math.floor(s.time * 5) % 2 === 0;
    for (const p of s.police) {
      const [cx, cy] = toPx(p.x, p.z);
      if (Math.hypot(cx - n / 2, cy - n / 2) > n / 2) continue;
      c.fillStyle = '#05060e';
      c.fillRect(cx - dot * 1.25, cy - dot * 1.25, dot * 2.5, dot * 2.5);
      c.fillStyle = blink ? '#ff3355' : '#3a7bff';
      c.fillRect(cx - dot * 0.85, cy - dot * 0.85, dot * 1.7, dot * 1.7);
    }
    // Shops and services: small badges (shape + colour) while they are inside the disc.
    for (const l of this.prepared.geom.landmarks) {
      if (l.kind === 'payphone' || l.kind === 'landmark') continue;
      const [lx, ly] = toPx(l.x, l.z);
      if (Math.hypot(lx - n / 2, ly - n / 2) > n / 2 - dot * 2) continue;
      drawLandmark(c, l.kind, lx, ly, dot * 3.4);
    }
    const rim = n / 2 - dot * 2.6;
    const clampRim = (p: [number, number]): [number, number, boolean] => {
      const dx = p[0] - n / 2;
      const dy = p[1] - n / 2;
      const len = Math.hypot(dx, dy);
      if (len <= rim) return [p[0], p[1], false];
      return [n / 2 + (dx * rim) / len, n / 2 + (dy * rim) / len, true];
    };
    if (!s.objective) {
      for (const ph of s.payphones) {
        const [cx, cy, edge] = clampRim(toPx(ph.x, ph.z));
        c.globalAlpha = edge ? 0.75 : 1;
        drawCrewMark(c, crewById(ph.crew), cx, cy, dot * (edge ? 3.2 : 4.2));
      }
      c.globalAlpha = 1;
    }
    if (!s.objective) {
      for (const a of s.activities) {
        const [cx, cy] = toPx(a.x, a.z);
        if (Math.hypot(cx - n / 2, cy - n / 2) > rim) continue;
        drawActivity(c, a.kind, cx, cy, dot * (a.kind === 'shard' ? 3 : 3.8), a.done);
      }
    }
    if (s.waypoint) {
      const [cx, cy] = clampRim(toPx(s.waypoint.x, s.waypoint.z));
      drawWaypoint(c, cx, cy + dot * 1.2, dot * 2.6);
    }
    if (s.objective) {
      const [cx, cy, edge] = clampRim(toPx(s.objective.x, s.objective.z));
      drawObjective(c, cx, cy, dot * (edge ? 2 : 2.6), s.time);
    }
    drawPlayerArrow(c, n / 2, n / 2, this.rotate ? 0 : angle, dot * 3);
    // Compass "N" rides the rim when the map rotates.
    const na = Math.round((rot - Math.PI / 2) * 100) / 100;
    if (na !== this.compassAngle) {
      this.compassAngle = na;
      const r = this.cssSize / 2 - 1;
      this.compass.style.transform = `translate(-50%, -50%) translate(${(Math.cos(na) * r).toFixed(1)}px, ${(Math.sin(na) * r).toFixed(1)}px)`;
    }
  }
}
