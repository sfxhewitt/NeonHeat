export interface MinimapStatic {
  /** World size in metres (x, z), centred on the origin. */
  size: [number, number];
  roads: { positions: number[]; width: number; extent: number };
  buildings: { x: number; z: number; w: number; d: number; h: number }[];
}

export interface MinimapDot {
  x: number;
  z: number;
  kind: 'police' | 'target' | 'giver' | 'car';
}

/** Metres shown across the minimap. */
const SPAN = 150;

/**
 * North-up circular minimap: a pre-painted city layer (roads, buildings by
 * height), the player arrow in the centre, police, the current objective and
 * job givers. Objectives off the edge are clamped to the rim. Redraws at
 * about 12 Hz, never allocates per frame.
 */
export class Minimap {
  readonly root: HTMLElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly layer: HTMLCanvasElement;
  private readonly px: number;
  private readonly scale: number;
  private readonly half: [number, number];
  private acc = 0;

  constructor(parent: HTMLElement, map: MinimapStatic, dpr = Math.min(3, globalThis.devicePixelRatio || 1)) {
    this.root = document.createElement('div');
    this.root.className = 'nh-minimap';
    this.root.setAttribute('aria-hidden', 'true');
    const canvas = document.createElement('canvas');
    this.px = Math.round(104 * dpr);
    canvas.width = canvas.height = this.px;
    this.root.appendChild(canvas);
    parent.appendChild(this.root);
    this.ctx = canvas.getContext('2d')!;
    // City layer at a fixed metres-to-pixels scale.
    this.scale = this.px / SPAN;
    this.half = [map.size[0] / 2, map.size[1] / 2];
    this.layer = document.createElement('canvas');
    this.layer.width = Math.ceil(map.size[0] * this.scale);
    this.layer.height = Math.ceil(map.size[1] * this.scale);
    const g = this.layer.getContext('2d')!;
    const s = this.scale;
    g.fillStyle = '#0c0c1c';
    g.fillRect(0, 0, this.layer.width, this.layer.height);
    g.fillStyle = '#2a2850';
    const { positions, width, extent } = map.roads;
    for (const p of positions) {
      g.fillRect((-extent + this.half[0]) * s, (p - width / 2 + this.half[1]) * s, extent * 2 * s, width * s);
      g.fillRect((p - width / 2 + this.half[0]) * s, (-extent + this.half[1]) * s, width * s, extent * 2 * s);
    }
    for (const b of map.buildings) {
      const t = Math.min(1, b.h / 40);
      g.fillStyle = `rgb(${Math.round(38 + 40 * t)}, ${Math.round(34 + 22 * t)}, ${Math.round(70 + 50 * t)})`;
      g.fillRect((b.x - b.w / 2 + this.half[0]) * s, (b.z - b.d / 2 + this.half[1]) * s, b.w * s, b.d * s);
    }
  }

  /** Redraw around the player. `facing` is the heading in radians (0 = +z, south on screen). */
  update(dt: number, x: number, z: number, facing: number, dots: readonly MinimapDot[], time: number): void {
    this.acc += dt;
    if (this.acc < 1 / 12) return;
    this.acc = 0;
    const c = this.ctx;
    const n = this.px;
    const s = this.scale;
    c.save();
    c.clearRect(0, 0, n, n);
    c.beginPath();
    c.arc(n / 2, n / 2, n / 2, 0, Math.PI * 2);
    c.clip();
    c.drawImage(this.layer, -(x + this.half[0]) * s + n / 2, -(z + this.half[1]) * s + n / 2);
    const rim = n / 2 - 7;
    for (const d of dots) {
      let dx = (d.x - x) * s;
      let dz = (d.z - z) * s;
      const len = Math.hypot(dx, dz);
      const edge = d.kind === 'target' || d.kind === 'giver';
      if (len > rim) {
        if (!edge) continue;
        dx *= rim / len;
        dz *= rim / len;
      }
      const cx = n / 2 + dx;
      const cy = n / 2 + dz;
      if (d.kind === 'police') {
        c.fillStyle = Math.floor(time * 6) % 2 ? '#ff2a3d' : '#2f6bff';
        c.fillRect(cx - 3, cy - 3, 6, 6);
      } else if (d.kind === 'target') {
        const r = 5 + Math.sin(time * 6) * 1.5;
        c.strokeStyle = '#ff2bd6';
        c.lineWidth = 2.5;
        c.beginPath();
        c.arc(cx, cy, r, 0, Math.PI * 2);
        c.stroke();
      } else if (d.kind === 'giver') {
        c.fillStyle = '#d7ff2b';
        c.beginPath();
        c.moveTo(cx, cy - 5);
        c.lineTo(cx + 4, cy);
        c.lineTo(cx, cy + 5);
        c.lineTo(cx - 4, cy);
        c.fill();
      } else {
        c.fillStyle = 'rgba(200, 200, 230, 0.55)';
        c.fillRect(cx - 1.5, cy - 1.5, 3, 3);
      }
    }
    // Player arrow.
    c.translate(n / 2, n / 2);
    c.rotate(-facing + Math.PI);
    c.fillStyle = '#d7ff2b';
    c.shadowColor = '#d7ff2b';
    c.shadowBlur = 6;
    c.beginPath();
    c.moveTo(0, -8);
    c.lineTo(6, 6);
    c.lineTo(0, 3);
    c.lineTo(-6, 6);
    c.closePath();
    c.fill();
    c.restore();
  }
}
