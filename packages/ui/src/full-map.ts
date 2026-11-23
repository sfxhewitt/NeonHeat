import { ACTIVITY_STYLES, CREWS, LANDMARK_STYLES, activitySvg, crewById, crewSvg, drawActivity, drawCrewMark, drawLandmark, landmarkSvg } from './icons';
import { routeLength } from './map-geometry';
import { drawObjective, drawPlayerArrow, drawWaypoint, paintMap, strokeRoute, type PreparedMap } from './map-paint';
import { CONE_HEAT, type MapLiveState } from './minimap';
import { appPoint, appRect } from './screen';

export interface FullMapHooks {
  /** The player tapped the map: a new waypoint, or null to clear it. */
  onWaypoint: (p: { x: number; z: number } | null) => void;
}

const FONT = '"Chakra Petch", "Avenir Next Condensed", "Roboto Condensed", system-ui, sans-serif';
const TAP_SLOP = 10;

/**
 * Full-screen city map: pan with one finger, pinch to zoom, wheel on desktop.
 * Districts are tinted and labelled; landmarks, crew payphones, police, the
 * objective, the waypoint and the GPS route are drawn on top. Tap anywhere to
 * set a waypoint (tap it again to clear). Redraws only when something changed.
 */
export class FullMap {
  readonly root: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly readout: HTMLElement;
  private readonly legend: HTMLElement;
  private cx = 0;
  private cz = 0;
  private zoom = 1;
  private minZoom = 0.2;
  private readonly maxZoom = 7;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private dirty = true;
  private raf = 0;
  private alive = true;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private gesture: { moved: number; t0: number; multi: boolean; x0: number; y0: number } | null = null;
  private pinch: { dist: number; zoom: number; mx: number; my: number } | null = null;
  private readonly ro: ResizeObserver | null = null;

  constructor(
    parent: HTMLElement,
    private readonly map: PreparedMap,
    private readonly live: MapLiveState,
    private readonly hooks: FullMapHooks,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'nh-fullmap';
    this.root.innerHTML = `
      <canvas class="nh-fullmap__canvas" aria-label="City map. Tap to set a waypoint."></canvas>
      <div class="nh-fullmap__readout" aria-live="polite"></div>
      <div class="nh-fullmap__tools">
        <button type="button" class="nh-iconbtn" data-map="in" aria-label="Zoom in"><svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg></button>
        <button type="button" class="nh-iconbtn" data-map="out" aria-label="Zoom out"><svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg></button>
        <button type="button" class="nh-iconbtn" data-map="me" aria-label="Centre on me"><svg viewBox="0 0 24 24"><path d="M12 3l6.5 16-6.5-3.6L5.5 19z"/></svg></button>
        <button type="button" class="nh-iconbtn" data-map="key" aria-label="Map key"><svg viewBox="0 0 24 24"><path d="M4 5h3v3H4zM9 5.5h11v2H9zM4 10.5h3v3H4zM9 11h11v2H9zM4 16h3v3H4zM9 16.5h11v2H9z"/></svg></button>
      </div>
      <div class="nh-fullmap__legend" hidden></div>`;
    this.canvas = this.root.querySelector('canvas')!;
    this.ctx = this.canvas.getContext('2d')!;
    this.readout = this.root.querySelector('.nh-fullmap__readout') as HTMLElement;
    this.legend = this.root.querySelector('.nh-fullmap__legend') as HTMLElement;
    this.legend.innerHTML =
      `<h4>Crews</h4>` +
      CREWS.map((c) => `<div>${crewSvg(c, 14)}<span>${c.name}</span></div>`).join('') +
      `<h4>Places</h4>` +
      (['clinic', 'precinct', 'safehouse', 'respray', 'arms', 'chopshop'] as const)
        .map((k) => `<div>${landmarkSvg(k, 14)}<span>${LANDMARK_STYLES[k].name}</span></div>`)
        .join('') +
      `<h4>Side jobs</h4>` +
      (['rampage', 'jump', 'race', 'fare'] as const).map((k) => `<div>${activitySvg(k, 14)}<span>${ACTIVITY_STYLES[k].name}</span></div>`).join('') +
      `<div><i class="nh-key-route"></i><span>GPS route</span></div><div><i class="nh-key-obj"></i><span>Objective</span></div>`;
    this.root.querySelector('.nh-fullmap__tools')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest('button');
      if (!b) return;
      const act = b.dataset.map;
      if (act === 'in') this.zoomAt(this.w / 2, this.h / 2, 1.6);
      else if (act === 'out') this.zoomAt(this.w / 2, this.h / 2, 1 / 1.6);
      else if (act === 'me') this.centreOnPlayer();
      else if (act === 'key') this.legend.hidden = !this.legend.hidden;
    });
    this.bindPointers();
    parent.appendChild(this.root);
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(this.root);
    }
    this.resize();
    this.fit();
    this.centreOnPlayer();
    const loop = (): void => {
      if (!this.alive) return;
      this.raf = requestAnimationFrame(loop);
      if (this.dirty) this.render();
    };
    loop();
  }

  /** Call when the live state changed (player moved, new route). */
  invalidate(): void {
    this.dirty = true;
  }

  destroy(): void {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.ro?.disconnect();
    this.root.remove();
  }

  centreOnPlayer(): void {
    this.cx = this.live.x;
    this.cz = this.live.z;
    this.clamp();
    this.dirty = true;
  }

  /** Current view (tests, and to restore the view next time the map opens). */
  get view(): { x: number; z: number; zoom: number } {
    return { x: this.cx, z: this.cz, zoom: this.zoom };
  }

  setView(v: { x: number; z: number; zoom: number }): void {
    this.cx = v.x;
    this.cz = v.z;
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, v.zoom));
    this.clamp();
    this.dirty = true;
  }

  private fit(): void {
    const [sw, sd] = this.map.geom.size;
    const fit = Math.min(this.w / sw, this.h / sd) || 1;
    this.minZoom = fit * 0.85;
    // A small map opens whole; a big city opens about 800 m across around the player.
    this.zoom = Math.max(fit * 0.92, 0.9);
  }

  private resize(): void {
    const r = appRect(this.root);
    const w = Math.max(1, Math.round(r.width));
    const h = Math.max(1, Math.round(r.height));
    const dpr = Math.min(3, globalThis.devicePixelRatio || 1);
    if (w === this.w && h === this.h && dpr === this.dpr) return;
    const first = this.w === 0;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    if (first) this.fit();
    else this.minZoom = Math.min(w / this.map.geom.size[0], h / this.map.geom.size[1]) * 0.85;
    this.dirty = true;
  }

  private clamp(): void {
    const [sw, sd] = this.map.geom.size;
    const hx = Math.max(0, sw / 2 - this.w / 2 / this.zoom + 40);
    const hz = Math.max(0, sd / 2 - this.h / 2 / this.zoom + 40);
    this.cx = Math.max(-hx, Math.min(hx, this.cx));
    this.cz = Math.max(-hz, Math.min(hz, this.cz));
  }

  private toScreen = (x: number, z: number): [number, number] => [this.w / 2 + (x - this.cx) * this.zoom, this.h / 2 + (z - this.cz) * this.zoom];

  private toWorld(sx: number, sy: number): { x: number; z: number } {
    return { x: this.cx + (sx - this.w / 2) / this.zoom, z: this.cz + (sy - this.h / 2) / this.zoom };
  }

  private zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.max(this.minZoom, Math.min(this.maxZoom, this.zoom * factor));
    const after = this.toWorld(sx, sy);
    this.cx += before.x - after.x;
    this.cz += before.z - after.z;
    this.clamp();
    this.dirty = true;
  }

  private local(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const p = appPoint(e.clientX, e.clientY);
    const r = appRect(this.canvas);
    return { x: p.x - r.x, y: p.y - r.y };
  }

  private bindPointers(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      c.setPointerCapture(e.pointerId);
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) this.gesture = { moved: 0, t0: performance.now(), multi: false, x0: p.x, y0: p.y };
      else if (this.gesture) this.gesture.multi = true;
      if (this.pointers.size === 2) this.startPinch();
    });
    c.addEventListener('pointermove', (e) => {
      const prev = this.pointers.get(e.pointerId);
      if (!prev) return;
      const p = this.local(e);
      this.pointers.set(e.pointerId, p);
      if (this.pointers.size === 1) {
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        if (this.gesture) this.gesture.moved = Math.max(this.gesture.moved, Math.hypot(p.x - this.gesture.x0, p.y - this.gesture.y0));
        if (!this.gesture || this.gesture.moved > TAP_SLOP) {
          this.cx -= dx / this.zoom;
          this.cz -= dy / this.zoom;
          this.clamp();
          this.dirty = true;
        }
      } else if (this.pointers.size === 2 && this.pinch) {
        const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mx = (a.x + b.x) / 2;
        const my = (a.y + b.y) / 2;
        // Pan with the midpoint, zoom about it.
        this.cx -= (mx - this.pinch.mx) / this.zoom;
        this.cz -= (my - this.pinch.my) / this.zoom;
        this.pinch.mx = mx;
        this.pinch.my = my;
        const target = (this.pinch.zoom * dist) / Math.max(1, this.pinch.dist);
        this.zoomAt(mx, my, target / this.zoom);
      }
    });
    const end = (e: PointerEvent): void => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (this.pointers.size === 1) this.startPinch();
      if (this.pointers.size < 2) this.pinch = null;
      if (this.pointers.size === 0 && this.gesture) {
        const g = this.gesture;
        this.gesture = null;
        if (e.type === 'pointerup' && !g.multi && g.moved <= TAP_SLOP && performance.now() - g.t0 < 600) this.tap(p.x, p.y);
      }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const p = this.local(e);
        this.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false },
    );
  }

  private startPinch(): void {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) {
      this.pinch = null;
      return;
    }
    const [a, b] = pts as [{ x: number; y: number }, { x: number; y: number }];
    this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.zoom, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  private tap(sx: number, sy: number): void {
    const wp = this.live.waypoint;
    if (wp) {
      const [px, py] = this.toScreen(wp.x, wp.z);
      if (Math.hypot(px - sx, py - sy - 12) < 26) {
        this.hooks.onWaypoint(null);
        this.dirty = true;
        return;
      }
    }
    // Snap to a payphone or landmark under the finger.
    let best = 24;
    let snap: { x: number; z: number } | null = null;
    const consider = (x: number, z: number): void => {
      const [px, py] = this.toScreen(x, z);
      const d = Math.hypot(px - sx, py - sy);
      if (d < best) {
        best = d;
        snap = { x, z };
      }
    };
    for (const p of this.live.payphones) consider(p.x, p.z);
    for (const l of this.map.geom.landmarks) consider(l.x, l.z);
    const w = snap ?? this.toWorld(sx, sy);
    const [sw, sd] = this.map.geom.size;
    if (Math.abs(w.x) > sw / 2 || Math.abs(w.z) > sd / 2) return;
    this.hooks.onWaypoint({ x: w.x, z: w.z });
    this.dirty = true;
  }

  render(): void {
    this.dirty = false;
    const c = this.ctx;
    const d = this.dpr;
    const z = this.zoom;
    const s = this.live;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.fillStyle = '#05060e';
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    // Faint grid outside the city, so panning past the edge still reads as a map.
    c.setTransform(d, 0, 0, d, 0, 0);
    c.strokeStyle = 'rgba(80, 70, 160, 0.10)';
    c.lineWidth = 1;
    const step = 50 * z;
    if (step > 8) {
      const [ox, oy] = this.toScreen(0, 0);
      c.beginPath();
      for (let x = ((ox % step) + step) % step; x < this.w; x += step) {
        c.moveTo(x, 0);
        c.lineTo(x, this.h);
      }
      for (let y = ((oy % step) + step) % step; y < this.h; y += step) {
        c.moveTo(0, y);
        c.lineTo(this.w, y);
      }
      c.stroke();
    }
    c.setTransform(d * z, 0, 0, d * z, d * (this.w / 2 - this.cx * z), d * (this.h / 2 - this.cz * z));
    paintMap(c, this.map, z, { districts: true, centreLines: z > 1.6 });
    // City edge.
    const [sw, sd] = this.map.geom.size;
    c.strokeStyle = 'rgba(33, 240, 255, 0.35)';
    c.lineWidth = 1.5 / (d * z) * d;
    c.strokeRect(-sw / 2, -sd / 2, sw, sd);
    c.setTransform(d, 0, 0, d, 0, 0);
    this.drawDistrictLabels(c);
    strokeRoute(c, s.route, this.toScreen, 4, 0);
    // Police.
    if (s.heat > 0) {
      for (const p of s.police) {
        const [x, y] = this.toScreen(p.x, p.z);
        if (s.heat >= CONE_HEAT) {
          const a = Math.atan2(Math.cos(p.yaw), Math.sin(p.yaw));
          const r = 34 * z;
          const g = c.createRadialGradient(x, y, 0, x, y, r);
          g.addColorStop(0, 'rgba(255, 51, 85, 0.45)');
          g.addColorStop(1, 'rgba(255, 51, 85, 0)');
          c.fillStyle = g;
          c.beginPath();
          c.moveTo(x, y);
          c.arc(x, y, r, a - Math.PI / 6, a + Math.PI / 6);
          c.closePath();
          c.fill();
        }
        c.fillStyle = '#05060e';
        c.fillRect(x - 5, y - 5, 10, 10);
        c.fillStyle = '#ff3355';
        c.fillRect(x - 3.5, y - 3.5, 3.5, 7);
        c.fillStyle = '#3a7bff';
        c.fillRect(x, y - 3.5, 3.5, 7);
      }
    }
    // Landmarks and payphones, with labels when there is room.
    const labels = z > 0.8;
    c.font = `600 11px ${FONT}`;
    c.textAlign = 'center';
    c.textBaseline = 'top';
    for (const l of this.map.geom.landmarks) {
      if (l.kind === 'payphone') continue;
      const [x, y] = this.toScreen(l.x, l.z);
      if (x < -30 || y < -30 || x > this.w + 30 || y > this.h + 30) continue;
      drawLandmark(c, l.kind, x, y, 22);
      if (labels) this.label(c, l.label, x, y + 15, LANDMARK_STYLES[l.kind].colour);
    }
    for (const p of s.payphones) {
      const [x, y] = this.toScreen(p.x, p.z);
      const crew = crewById(p.crew);
      c.fillStyle = 'rgba(6, 7, 18, 0.9)';
      c.beginPath();
      c.arc(x, y, 13, 0, Math.PI * 2);
      c.fill();
      c.strokeStyle = crew.colour;
      c.lineWidth = 1.5;
      c.stroke();
      drawCrewMark(c, crew, x, y, 16);
      if (labels) this.label(c, p.title, x, y + 16, crew.colour);
    }
    // Side activities (shards stay hidden: finding them is the point).
    for (const a of s.activities) {
      if (a.kind === 'shard') continue;
      const [x, y] = this.toScreen(a.x, a.z);
      if (x < -30 || y < -30 || x > this.w + 30 || y > this.h + 30) continue;
      drawActivity(c, a.kind, x, y, 20, a.done);
      if (labels && z > 1.4) this.label(c, a.title, x, y + 13, ACTIVITY_STYLES[a.kind].colour);
    }
    if (s.objective) {
      const [x, y] = this.toScreen(s.objective.x, s.objective.z);
      drawObjective(c, x, y, 9, 0);
    }
    if (s.waypoint) {
      const [x, y] = this.toScreen(s.waypoint.x, s.waypoint.z);
      drawWaypoint(c, x, y, 13);
    }
    const [px, py] = this.toScreen(s.x, s.z);
    drawPlayerArrow(c, px, py, Math.PI - s.heading, 11);
    this.drawScale(c);
    this.updateReadout();
  }

  private label(c: CanvasRenderingContext2D, text: string, x: number, y: number, colour: string): void {
    c.lineWidth = 3;
    c.strokeStyle = 'rgba(5, 6, 14, 0.9)';
    c.strokeText(text, x, y);
    c.fillStyle = colour;
    c.fillText(text, x, y);
  }

  private drawDistrictLabels(c: CanvasRenderingContext2D): void {
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const pad = 28;
    for (const d of this.map.geom.districts) {
      // Label the part of the district that is on screen, so a name never sits off the edge.
      const [x0, y0] = this.toScreen(d.x - d.w / 2, d.z - d.d / 2);
      const [x1, y1] = this.toScreen(d.x + d.w / 2, d.z + d.d / 2);
      const l = Math.max(x0, pad);
      const r = Math.min(x1, this.w - pad - 56);
      const t = Math.max(y0, pad + 24);
      const b = Math.min(y1, this.h - pad);
      if (r - l < 110 || b - t < 36) continue;
      const size = Math.max(12, Math.min(22, (x1 - x0) / 14));
      c.font = `700 ${size.toFixed(0)}px ${FONT}`;
      const text = d.name.toUpperCase().split('').join('\u200A');
      if (c.measureText(text).width > r - l) continue;
      // Sit in the upper third of the visible part: icons cluster in the middle less often.
      const x = (l + r) / 2;
      const y = t + (b - t) * 0.22;
      c.globalAlpha = 0.6;
      c.lineWidth = 4;
      c.strokeStyle = 'rgba(5, 6, 14, 0.85)';
      c.strokeText(text, x, y);
      c.fillStyle = d.colour;
      c.fillText(text, x, y);
      c.globalAlpha = 1;
    }
  }

  private drawScale(c: CanvasRenderingContext2D): void {
    const steps = [10, 25, 50, 100, 200, 250, 500, 1000];
    let m = steps[0]!;
    for (const st of steps) if (st * this.zoom <= 110) m = st;
    const len = m * this.zoom;
    const x = 16;
    const y = this.h - 16;
    c.strokeStyle = 'rgba(233, 230, 255, 0.75)';
    c.lineWidth = 2;
    c.beginPath();
    c.moveTo(x, y - 5);
    c.lineTo(x, y);
    c.lineTo(x + len, y);
    c.lineTo(x + len, y - 5);
    c.stroke();
    c.font = `600 10px ${FONT}`;
    c.textAlign = 'left';
    c.textBaseline = 'bottom';
    c.fillStyle = 'rgba(233, 230, 255, 0.75)';
    c.fillText(m >= 1000 ? `${m / 1000} km` : `${m} m`, x + 4, y - 4);
  }

  private lastReadout = '';
  private updateReadout(): void {
    const s = this.live;
    let text = '';
    if (s.route.length >= 2) {
      const m = routeLength(s.route);
      const dist = m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 10) * 10} m`;
      text = `${s.objective ? 'Objective' : 'Waypoint'} · ${dist}`;
    } else text = 'Tap the map to set a waypoint';
    if (text !== this.lastReadout) {
      this.lastReadout = text;
      this.readout.textContent = text;
    }
  }
}
