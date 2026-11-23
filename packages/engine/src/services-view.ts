import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshLambertMaterial,
  ShaderMaterial,
  type Scene,
} from 'three';
import { layoutLamps, type EconomyConfig, type MapContent, type ServiceKind, type ServiceSite } from '@neonheat/sim';
import { BLOOM_LAYER } from './layers';
import { MeshBuilder } from './mesh-kit';
import type { Sign } from './signage';

/** Glyph paths (24×24 SVG box) per service kind, injected by the app so the map badges and the signs match. */
export type ServiceIcons = Record<ServiceKind, string>;

export interface ServicesViewOptions {
  brands: EconomyConfig['brands'];
  icons: ServiceIcons;
  /** Safehouse marker -> price, for the FOR SALE boards. */
  safehousePrices: Record<string, number>;
  /** Camera pitch in degrees: signs lean back to face the camera. */
  pitchDeg: number;
}

/** A packed rectangle in the atlas, in UV space. */
interface Tile {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

const ATLAS_W = 2048;
const ATLAS_H = 1024;
const SIGN_W = 512;
const SIGN_H = 160;
const ICON = 192;
const PAD = 256;
const FONT = "'Chakra Petch', 'Avenir Next Condensed', 'Roboto Condensed', system-ui, sans-serif";

const VERT = /* glsl */ `
attribute vec3 color;
attribute float pulse;
varying vec2 vUv;
varying vec3 vColor;
varying float vPulse;
void main() {
  vUv = uv;
  vColor = color;
  vPulse = pulse;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform sampler2D map;
uniform float uTime;
uniform float uAdditive;
varying vec2 vUv;
varying vec3 vColor;
varying float vPulse;
void main() {
  vec4 t = texture2D(map, vUv);
  if (t.a < 0.03) discard;
  float a = abs(vPulse);
  // |pulse| <= 1: a slow breathe; > 1: a fast flash (police light bars), anti-phase when negative.
  float s = a > 1.0 ? step(0.0, sin(uTime * 7.0 + (vPulse < 0.0 ? 3.14159 : 0.0))) * 1.6 - 0.6 : 1.0 + a * 0.35 * sin(uTime * 2.4);
  vec3 c = t.rgb * vColor * s;
  gl_FragColor = uAdditive > 0.5 ? vec4(c * t.a, 1.0) : vec4(c, t.a);
}`;

/** Emissive, textured quads (signs, decals, neon tubes) merged into one geometry. */
class GlowBuilder {
  readonly pos: number[] = [];
  readonly uv: number[] = [];
  readonly col: number[] = [];
  readonly pulse: number[] = [];
  private readonly c = new Color();

  /** Quad from four corners (counter-clockwise from the front), UVs from a tile. */
  quad(p: [number, number, number][], t: Tile, colour: number, intensity: number, pulse = 0, flipU = false): void {
    const [a, b, c, d] = p as [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
    const u0 = flipU ? t.u1 : t.u0;
    const u1 = flipU ? t.u0 : t.u1;
    const uvs: [number, number][] = [
      [u0, t.v0],
      [u1, t.v0],
      [u1, t.v1],
      [u0, t.v1],
    ];
    this.c.setHex(colour).multiplyScalar(intensity);
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const q = [a, b, c, d][i]!;
      this.pos.push(q[0], q[1], q[2]);
      this.uv.push(uvs[i]![0], uvs[i]![1]);
      this.col.push(this.c.r, this.c.g, this.c.b);
      this.pulse.push(pulse);
    }
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array(this.uv), 2));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('pulse', new BufferAttribute(new Float32Array(this.pulse), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** A site's local frame: +z towards the road (the front), +x along the street. */
class Frame {
  readonly yaw: number;
  constructor(
    readonly s: ServiceSite,
    private readonly ox = s.x,
    private readonly oz = s.z,
  ) {
    this.yaw = Math.atan2(s.fx, s.fz);
  }

  /** Local (x, y, z) to world. */
  w(lx: number, ly: number, lz: number): [number, number, number] {
    const { fx, fz } = this.s;
    return [this.ox + lx * fz + lz * fx, ly, this.oz - lx * fx + lz * fz];
  }
}

/**
 * Shop and service fronts. Each `clinic`, `precinct`, `safehouse`, `respray`,
 * `armsshop` and `chopshop` marker gets a readable front: a canopy over a lit
 * doorway (or a workshop door for drive-ins), a camera-facing sign with an
 * original name and the service's glyph, a flat glyph badge on the canopy or
 * roof for the top-down camera, and a glowing pad on the ground where you
 * walk or drive in. Colour always pairs with a shape (the glyph).
 *
 * The whole lot is three draw calls: one lit, vertex-coloured mesh for the
 * structure, one textured emissive mesh for signs and neon, one additive mesh
 * for the pads. One 2048×1024 canvas atlas holds every sign and glyph.
 */
export class ServicesView {
  readonly structure: Mesh;
  readonly glow: Mesh;
  readonly pads: Mesh;
  private readonly atlas: CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly tiles = new Map<string, Tile>();
  private readonly glowMat: ShaderMaterial;
  private readonly padMat: ShaderMaterial;
  private owned = new Set<string>();
  private readonly tilt: number;
  /** Street lamp spots, so a sign post stands clear of the nearest lamp head. */
  private readonly lamps: { x: number; z: number }[];

  constructor(
    scene: Scene,
    private readonly map: MapContent,
    readonly sites: readonly ServiceSite[],
    private readonly opts: ServicesViewOptions,
  ) {
    this.tilt = ((90 - opts.pitchDeg) * Math.PI) / 180;
    this.lamps = layoutLamps(map);
    this.canvas = document.createElement('canvas');
    this.canvas.width = ATLAS_W;
    this.canvas.height = ATLAS_H;
    this.packTiles();
    this.paintAtlas();
    this.atlas = new CanvasTexture(this.canvas);
    this.atlas.minFilter = LinearMipmapLinearFilter;
    this.atlas.magFilter = LinearFilter;
    this.atlas.anisotropy = 4;
    this.atlas.flipY = false;
    const mat = (additive: boolean): ShaderMaterial =>
      new ShaderMaterial({
        uniforms: { map: { value: this.atlas }, uTime: { value: 0 }, uAdditive: { value: additive ? 1 : 0 } },
        vertexShader: VERT,
        fragmentShader: FRAG,
        transparent: true,
        depthWrite: !additive,
        blending: additive ? AdditiveBlending : undefined,
        side: DoubleSide,
      });
    this.glowMat = mat(false);
    this.padMat = mat(true);
    this.structure = new Mesh(new BufferGeometry(), new MeshLambertMaterial({ vertexColors: true, flatShading: true }));
    this.glow = new Mesh(new BufferGeometry(), this.glowMat);
    this.pads = new Mesh(new BufferGeometry(), this.padMat);
    this.structure.name = 'service-fronts';
    this.glow.name = 'service-signs';
    this.pads.name = 'service-pads';
    // Signs and neon bloom; the pads are already additive and would turn into blobs.
    this.glow.layers.enable(BLOOM_LAYER);
    this.pads.renderOrder = 1;
    for (const m of [this.structure, this.glow, this.pads]) {
      m.matrixAutoUpdate = false;
      scene.add(m);
    }
    this.rebuild();
  }

  /** Safehouses you own show their sign; the others a FOR SALE board. */
  setOwned(ids: Iterable<string>): void {
    const next = new Set(ids);
    if (next.size === this.owned.size && [...next].every((i) => this.owned.has(i))) return;
    this.owned = next;
    this.rebuild();
  }

  /** Repaint the atlas (call once the web font has loaded). */
  redraw(): void {
    this.paintAtlas();
    this.atlas.needsUpdate = true;
  }

  update(time: number): void {
    this.glowMat.uniforms.uTime!.value = time;
    this.padMat.uniforms.uTime!.value = time;
  }

  /** Drop the city's random facade signs from the workshops behind drive-in pads (their own sign is enough). */
  clearSigns(signs: Sign[]): Sign[] {
    const boxes = this.sites
      .filter((s) => s.drive && s.back > 0)
      .map((s) => {
        const [qx, , qz] = new Frame(s).w(0, 0, -s.back - 1);
        return this.map.buildings.find((o) => Math.abs(qx - o.x) <= o.w / 2 && Math.abs(qz - o.z) <= o.d / 2);
      })
      .filter((b): b is NonNullable<typeof b> => !!b);
    return signs.filter((g) => !boxes.some((b) => Math.abs(g.x - b.x) <= b.w / 2 + 0.6 && Math.abs(g.z - b.z) <= b.d / 2 + 0.6));
  }

  /** Light the street around each front (for the light field and the wet-road reflections). */
  lights(): Sign[] {
    const out: Sign[] = [];
    for (const s of this.sites) {
      const f = new Frame(s);
      const colour = new Color(this.colour(s.kind)).getHex();
      const back = s.drive ? s.back : s.back > 0.5 && s.back < 9 ? s.back : 2.6;
      const [x, , z] = f.w(0, 0, -back + 0.6);
      out.push({ x, y: s.drive ? 3 : 3.4, z, w: s.fx === 0 ? 4 : 0.4, h: 2.4, d: s.fx === 0 ? 0.4 : 4, colour, nx: s.fx, nz: s.fz });
      // Drive-ins: a warm floodlight over the yard so the pad is not in the dark.
      if (s.drive) out.push({ x: s.x, y: 5, z: s.z, w: 8, h: 1, d: 1, colour: 0xffe2b0, nx: 0, nz: 0 });
    }
    return out;
  }

  private colour(kind: ServiceKind): string {
    return this.opts.brands[kind]?.colour ?? '#ffffff';
  }

  // ------------------------------------------------------------------ atlas

  private packTiles(): void {
    const want: [string, number, number][] = [];
    for (const k of Object.keys(this.opts.icons) as ServiceKind[]) want.push([`sign:${k}`, SIGN_W, SIGN_H]);
    for (const s of this.sites) if (s.kind === 'safehouse') want.push([`sale:${s.id}`, SIGN_W, SIGN_H]);
    for (const k of Object.keys(this.opts.icons) as ServiceKind[]) want.push([`icon:${k}`, ICON, ICON]);
    for (const k of Object.keys(this.opts.icons) as ServiceKind[]) want.push([`glyph:${k}`, ICON, ICON]);
    want.push(['pad:walk', PAD, PAD], ['pad:drive', PAD, PAD], ['white', 16, 16], ['door', 64, 128], ['slats', 64, 128], ['spill', 128, 128]);
    let x = 0;
    let y = 0;
    let row = 0;
    for (const [key, w, h] of want) {
      if (x + w > ATLAS_W) {
        x = 0;
        y += row + 4;
        row = 0;
      }
      if (y + h > ATLAS_H) throw new Error('Service atlas is full');
      // Inset UVs by a pixel so mipmaps do not bleed between tiles.
      this.tiles.set(key, { u0: (x + 1) / ATLAS_W, v0: (y + 1) / ATLAS_H, u1: (x + w - 1) / ATLAS_W, v1: (y + h - 1) / ATLAS_H });
      x += w + 4;
      row = Math.max(row, h);
    }
  }

  private tile(key: string): Tile {
    return this.tiles.get(key)!;
  }

  private px(key: string): { x: number; y: number; w: number; h: number } {
    const t = this.tile(key);
    return { x: t.u0 * ATLAS_W - 1, y: t.v0 * ATLAS_H - 1, w: (t.u1 - t.u0) * ATLAS_W + 2, h: (t.v1 - t.v0) * ATLAS_H + 2 };
  }

  private glyph(c: CanvasRenderingContext2D, kind: ServiceKind, cx: number, cy: number, size: number, fill: string): void {
    const k = size / 24;
    c.save();
    c.translate(cx - 12 * k, cy - 12 * k);
    c.scale(k, k);
    c.fillStyle = fill;
    c.fill(new Path2D(this.opts.icons[kind]));
    c.restore();
  }

  private paintAtlas(): void {
    const c = this.canvas.getContext('2d')!;
    c.clearRect(0, 0, ATLAS_W, ATLAS_H);
    const kinds = Object.keys(this.opts.icons) as ServiceKind[];
    for (const k of kinds) {
      const b = this.opts.brands[k];
      this.paintSign(c, this.px(`sign:${k}`), k, b?.name ?? k.toUpperCase(), (b?.tagline ?? '').toUpperCase(), this.colour(k));
      this.paintIcon(c, this.px(`icon:${k}`), k, this.colour(k), true);
      this.paintIcon(c, this.px(`glyph:${k}`), k, this.colour(k), false);
    }
    for (const s of this.sites) {
      if (s.kind !== 'safehouse') continue;
      const price = this.opts.safehousePrices[s.id] ?? 0;
      this.paintSign(c, this.px(`sale:${s.id}`), 'safehouse', 'FOR SALE', `${price.toLocaleString('en-GB')} CR · TAP BUY`, '#e9e6ff');
    }
    this.paintPad(c, this.px('pad:walk'), false);
    this.paintPad(c, this.px('pad:drive'), true);
    const w = this.px('white');
    c.fillStyle = '#ffffff';
    c.fillRect(w.x, w.y, w.w, w.h);
    // A lit doorway: bright at the floor, fading up, with a frame line.
    const d = this.px('door');
    const g = c.createLinearGradient(0, d.y + d.h, 0, d.y);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.55, 'rgba(255,255,255,0.55)');
    g.addColorStop(1, 'rgba(255,255,255,0.25)');
    c.fillStyle = g;
    c.fillRect(d.x, d.y, d.w, d.h);
    // Light spilling on the ground: a soft blob.
    const sp = this.px('spill');
    const sg = c.createRadialGradient(sp.x + sp.w / 2, sp.y + sp.h / 2, 0, sp.x + sp.w / 2, sp.y + sp.h / 2, sp.w / 2);
    sg.addColorStop(0, 'rgba(255,255,255,0.9)');
    sg.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = sg;
    c.fillRect(sp.x, sp.y, sp.w, sp.h);
    // A half-raised roller door: slats over a lit gap at the bottom.
    const r = this.px('slats');
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.fillRect(r.x, r.y, r.w, r.h);
    c.fillStyle = 'rgba(40,40,60,1)';
    for (let i = 0; i < 9; i++) c.fillRect(r.x, r.y + i * 8, r.w, 6);
  }

  private paintSign(c: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, kind: ServiceKind, title: string, sub: string, colour: string): void {
    c.save();
    const m = 10;
    c.beginPath();
    c.roundRect(r.x + m, r.y + m, r.w - m * 2, r.h - m * 2, 14);
    c.fillStyle = 'rgba(8, 8, 22, 0.94)';
    c.fill();
    c.shadowColor = colour;
    c.shadowBlur = 14;
    c.lineWidth = 6;
    c.strokeStyle = colour;
    c.stroke();
    c.shadowBlur = 0;
    // Glyph badge on the left.
    const bx = r.x + 30 + 50;
    const by = r.y + r.h / 2;
    c.beginPath();
    c.arc(bx, by, 50, 0, Math.PI * 2);
    c.fillStyle = colour;
    c.fill();
    this.glyph(c, kind, bx, by, 64, '#080816');
    // Name, fitted to the space.
    const tx = bx + 66;
    const maxW = r.x + r.w - 26 - tx;
    let size = 62;
    c.font = `700 ${size}px ${FONT}`;
    while (c.measureText(title).width > maxW && size > 24) {
      size -= 2;
      c.font = `700 ${size}px ${FONT}`;
    }
    c.textBaseline = 'alphabetic';
    c.textAlign = 'left';
    c.shadowColor = colour;
    c.shadowBlur = 6;
    c.fillStyle = '#f4f2ff';
    c.fillText(title, tx, by + (sub ? 10 : size * 0.36));
    c.shadowBlur = 0;
    if (sub) {
      let s2 = 22;
      c.font = `600 ${s2}px ${FONT}`;
      while (c.measureText(sub).width > maxW && s2 > 12) {
        s2 -= 1;
        c.font = `600 ${s2}px ${FONT}`;
      }
      c.fillStyle = colour;
      c.fillText(sub, tx + 2, by + 44);
    }
    c.restore();
  }

  private paintIcon(c: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, kind: ServiceKind, colour: string, badge: boolean): void {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    c.save();
    if (badge) {
      c.beginPath();
      c.arc(cx, cy, r.w / 2 - 8, 0, Math.PI * 2);
      c.fillStyle = 'rgba(8, 8, 22, 0.96)';
      c.fill();
      c.lineWidth = 10;
      c.strokeStyle = colour;
      c.shadowColor = colour;
      c.shadowBlur = 10;
      c.stroke();
      c.shadowBlur = 0;
      this.glyph(c, kind, cx, cy, r.w * 0.56, colour);
    } else {
      c.shadowColor = colour;
      c.shadowBlur = 12;
      this.glyph(c, kind, cx, cy, r.w * 0.78, colour);
    }
    c.restore();
  }

  private paintPad(c: CanvasRenderingContext2D, r: { x: number; y: number; w: number; h: number }, drive: boolean): void {
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const R = r.w / 2 - 10;
    c.save();
    // Soft inner glow.
    const g = c.createRadialGradient(cx, cy, R * 0.2, cx, cy, R);
    g.addColorStop(0, 'rgba(255,255,255,0.0)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.04)');
    g.addColorStop(1, 'rgba(255,255,255,0.16)');
    c.fillStyle = g;
    c.beginPath();
    c.arc(cx, cy, R, 0, Math.PI * 2);
    c.fill();
    // Solid ring and a dashed outer ring.
    c.strokeStyle = '#ffffff';
    c.shadowColor = '#ffffff';
    c.shadowBlur = 8;
    c.lineWidth = 9;
    c.beginPath();
    c.arc(cx, cy, R - 6, 0, Math.PI * 2);
    c.stroke();
    c.lineWidth = 5;
    c.setLineDash([16, 12]);
    c.beginPath();
    c.arc(cx, cy, R - 22, 0, Math.PI * 2);
    c.stroke();
    c.setLineDash([]);
    if (drive) {
      // Chevrons pointing up the tile (towards the workshop door).
      c.lineWidth = 10;
      c.lineJoin = 'round';
      for (let i = 0; i < 3; i++) {
        const y = cy - R * 0.62 + i * 26 - 8;
        c.globalAlpha = 1 - i * 0.25;
        c.beginPath();
        c.moveTo(cx - 34, y + 22);
        c.lineTo(cx, y);
        c.lineTo(cx + 34, y + 22);
        c.stroke();
      }
      c.globalAlpha = 1;
    }
    c.restore();
  }

  // ------------------------------------------------------------------ geometry

  private rebuild(): void {
    const sb = new MeshBuilder();
    const gb = new GlowBuilder();
    const pb = new GlowBuilder();
    for (const s of this.sites) {
      if (s.drive) this.buildWorkshop(s, sb, gb, pb);
      else this.buildFront(s, sb, gb, pb);
    }
    this.structure.geometry.dispose();
    this.glow.geometry.dispose();
    this.pads.geometry.dispose();
    this.structure.geometry = sb.build();
    this.structure.geometry.computeBoundingSphere();
    this.glow.geometry = gb.build();
    this.pads.geometry = pb.build();
  }

  /** A flat square decal lying on a horizontal surface at height y, upright on screen (top = north). */
  private decal(b: GlowBuilder, x: number, y: number, z: number, size: number, t: Tile, colour: number, intensity: number, pulse = 0, yaw = 0): void {
    const h = size / 2;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    // Tile top (v0) towards -z (north) when yaw = 0; yaw turns it about +y.
    const pt = (lx: number, lz: number): [number, number, number] => [x + lx * c + lz * s, y, z - lx * s + lz * c];
    b.quad([pt(-h, -h), pt(h, -h), pt(h, h), pt(-h, h)], t, colour, intensity, pulse);
  }

  /** A sign panel facing the camera (leaning back by the camera's pitch), centred at (x, y, z). */
  private camPanel(b: GlowBuilder, x: number, y: number, z: number, w: number, h: number, t: Tile, intensity: number, pulse = 0): void {
    const hw = w / 2;
    const uy = Math.cos(this.tilt) * (h / 2);
    const uz = -Math.sin(this.tilt) * (h / 2);
    b.quad(
      [
        [x - hw, y + uy, z + uz],
        [x + hw, y + uy, z + uz],
        [x + hw, y - uy, z - uz],
        [x - hw, y - uy, z - uz],
      ],
      t,
      0xffffff,
      intensity,
      pulse,
    );
  }

  /** A box of emissive colour (a neon tube or light bar) in a site's local frame. */
  private tube(b: GlowBuilder, f: Frame, cx: number, cy: number, cz: number, w: number, h: number, d: number, colour: number, intensity: number, pulse = 0): void {
    const t = this.tile('white');
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const y0 = cy - h / 2;
    const y1 = cy + h / 2;
    const z0 = cz - d / 2;
    const z1 = cz + d / 2;
    const P = (x: number, y: number, z: number): [number, number, number] => f.w(x, y, z);
    b.quad([P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0)], t, colour, intensity, pulse);
    b.quad([P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1)], t, colour, intensity, pulse);
    b.quad([P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0)], t, colour, intensity, pulse);
    b.quad([P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1)], t, colour, intensity, pulse);
    b.quad([P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0)], t, colour, intensity, pulse);
  }

  /** A textured vertical quad on a facade, facing +z of the local frame. */
  private facadeQuad(b: GlowBuilder, f: Frame, cx: number, cy: number, z: number, w: number, h: number, t: Tile, colour: number, intensity: number, pulse = 0): void {
    const P = (x: number, y: number): [number, number, number] => f.w(x, y, z);
    b.quad([P(cx - w / 2, cy + h / 2), P(cx + w / 2, cy + h / 2), P(cx + w / 2, cy - h / 2), P(cx - w / 2, cy - h / 2)], t, colour, intensity, pulse);
  }

  /** Walk-in front: a canopy over a lit doorway on the building face (or a kiosk), a sign and a pad. */
  private buildFront(s: ServiceSite, sb: MeshBuilder, gb: GlowBuilder, pb: GlowBuilder): void {
    const f = new Frame(s);
    const col = new Color(this.colour(s.kind)).getHex();
    const dark = new Color(this.colour(s.kind)).multiplyScalar(0.18).getHex();
    const onFace = s.back > 0.5 && s.back < 9;
    const faceZ = onFace ? -s.back : -3.4;
    const width = onFace ? Math.max(4.5, Math.min(7, s.faceWidth - 1)) : 4.2;
    const yaw = f.yaw;
    const box = (lx: number, ly: number, lz: number, w: number, h: number, d: number, c: number): void => {
      const [x, , z] = f.w(lx, 0, lz);
      sb.box(x, ly, z, w, h, d, c, { rot: [0, yaw, 0] });
    };
    if (!onFace) {
      // A kiosk: walls, a roof and a counter, its open side towards the pad.
      box(0, 1.5, faceZ - 1.2, width, 3, 2.4, 0x1c1a33);
      box(0, 3.1, faceZ - 1.05, width + 0.3, 0.2, 2.8, 0x2a2748);
    }
    // Shopfront: a dark glass panel with the lit doorway in it.
    box(0, 1.65, faceZ + 0.06, width, 3.3, 0.12, 0x10101e);
    this.facadeQuad(gb, f, 0, 1.35, faceZ + 0.14, 1.7, 2.6, this.tile('door'), col, 0.85);
    this.tube(gb, f, -0.95, 1.4, faceZ + 0.18, 0.12, 2.8, 0.12, col, 2.2);
    this.tube(gb, f, 0.95, 1.4, faceZ + 0.18, 0.12, 2.8, 0.12, col, 2.2);
    this.tube(gb, f, 0, 2.82, faceZ + 0.18, 2.02, 0.12, 0.12, col, 2.2);
    // Window strips either side of the door.
    for (const side of [-1, 1]) this.facadeQuad(gb, f, (side * (1.05 + width / 2)) / 2, 1.7, faceZ + 0.13, width / 2 - 1.4, 1.2, this.tile('white'), col, 0.22);
    // Canopy: dark slab with a neon edge; the glyph badge on top for the top-down camera.
    const depth = 2.5;
    const cz = faceZ + depth / 2 + 0.1;
    box(0, 3.45, cz, width + 0.4, 0.28, depth, dark);
    this.tube(gb, f, 0, 3.32, faceZ + depth + 0.12, width + 0.44, 0.1, 0.1, col, 2.4);
    this.tube(gb, f, -(width / 2 + 0.22), 3.32, cz, 0.1, 0.1, depth, col, 2.4);
    this.tube(gb, f, width / 2 + 0.22, 3.32, cz, 0.1, 0.1, depth, col, 2.4);
    const [bx, , bz] = f.w(0, 0, cz);
    this.decal(gb, bx, 3.61, bz, Math.min(2.3, depth - 0.2), this.tile(`icon:${s.kind}`), 0xffffff, 1.25);
    // Police light bar on the precinct canopy.
    if (s.kind === 'precinct') {
      for (let i = 0; i < 6; i++) {
        const lx = -width / 2 + 0.5 + (i * (width - 1)) / 5;
        this.tube(gb, f, lx, 3.68, faceZ + depth - 0.1, 0.5, 0.16, 0.3, i % 2 ? 0x3a6bff : 0xff2440, 2.6, i % 2 ? -2 : 2);
      }
    }
    // Sign: a panel on a post at the kerb beside the pad, leaning back to face the camera. At the
    // kerb it clears the building even when the front faces away from the camera.
    const signKey = s.kind === 'safehouse' && !this.owned.has(s.id) ? `sale:${s.id}` : `sign:${s.kind}`;
    const clearance = (lx: number): number => {
      const [x, , z] = f.w(lx, 0, 1.55);
      let d = Infinity;
      for (const l of this.lamps) d = Math.min(d, Math.hypot(l.x - x, l.z - z));
      return d;
    };
    const side = clearance(width / 2 - 0.2) >= clearance(-(width / 2 - 0.2)) ? 1 : -1;
    const [sx, , sz] = f.w(side * (width / 2 - 0.2), 0, 1.55);
    const postH = 4.6;
    sb.box(sx, postH / 2, sz, 0.2, postH, 0.2, 0x2a2840);
    sb.box(sx, 0.1, sz, 0.6, 0.2, 0.6, 0x2a2840);
    this.camPanel(gb, sx, postH + 0.75, sz, 4.8, 1.5, this.tile(signKey), 1.05);
    // Coloured light spilling out of the doorway onto the pavement.
    const [px, , pz] = f.w(0, 0, faceZ + 2.2);
    this.decal(pb, px, 0.205, pz, 6.5, this.tile('spill'), col, 0.28);
    // The pad.
    if (s.kind !== 'precinct') {
      const r = 2.2;
      const sale = s.kind === 'safehouse' && !this.owned.has(s.id);
      const padCol = sale ? 0xe9e6ff : col;
      this.decal(pb, s.x, 0.22, s.z, r * 2, this.tile('pad:walk'), padCol, sale ? 0.6 : 0.9, 0.5);
      this.decal(pb, s.x, 0.23, s.z, r * 1.0, this.tile(`glyph:${s.kind}`), padCol, sale ? 0.6 : 0.9, 0.5);
    }
  }

  /** Drive-in workshop: a lit roller door on the workshop face, a roof sign and badge, a big pad in the yard. */
  private buildWorkshop(s: ServiceSite, sb: MeshBuilder, gb: GlowBuilder, pb: GlowBuilder): void {
    const f = new Frame(s);
    const col = new Color(this.colour(s.kind)).getHex();
    const faceZ = -s.back;
    // The workshop building behind the pad (from the map), for its roof height and size.
    const [qx, , qz] = f.w(0, 0, faceZ - 1);
    const b = this.map.buildings.find((o) => Math.abs(qx - o.x) <= o.w / 2 && Math.abs(qz - o.z) <= o.d / 2);
    const roof = b?.h ?? 6;
    const along = b ? (s.fx === 0 ? b.w : b.d) : 12;
    const deep = b ? (s.fx === 0 ? b.d : b.w) : 10;
    const doorW = 6.4;
    const doorH = Math.min(4.4, roof - 1.2);
    // Roller door: slats over a lit gap, inside a neon frame; a dark lintel band.
    this.facadeQuad(gb, f, 0, doorH / 2, faceZ + 0.06, doorW, doorH, this.tile('slats'), col, 0.55);
    this.tube(gb, f, -doorW / 2 - 0.1, doorH / 2, faceZ + 0.12, 0.16, doorH + 0.2, 0.16, col, 2.4);
    this.tube(gb, f, doorW / 2 + 0.1, doorH / 2, faceZ + 0.12, 0.16, doorH + 0.2, 0.16, col, 2.4);
    this.tube(gb, f, 0, doorH + 0.1, faceZ + 0.12, doorW + 0.36, 0.16, 0.16, col, 2.4);
    // Hazard-striped lintel and yard lamps on the face.
    const [lx, , lz] = f.w(0, 0, faceZ + 0.15);
    sb.box(lx, doorH + 0.55, lz, doorW + 2, 0.7, 0.3, 0x1b1a30, { rot: [0, f.yaw, 0] });
    for (const sd of [-1, 1]) this.tube(gb, f, sd * (doorW / 2 + 1.6), doorH + 0.2, faceZ + 0.35, 0.9, 0.2, 0.5, 0xfff2d0, 1.6);
    // Roof: the glyph badge flat on the roof, and a camera-facing sign standing on the front edge.
    const [rx, , rz] = f.w(0, 0, faceZ - deep / 2);
    this.decal(gb, rx, roof + 0.06, rz, Math.min(7, deep - 1.5, along - 2), this.tile(`icon:${s.kind}`), 0xffffff, 1.2);
    const [fx, , fz] = f.w(0, 0, faceZ - 0.8);
    const signW = Math.min(10, along - 1);
    sb.box(fx, roof + 0.6, fz, signW * 0.9, 1.2, 0.25, 0x22203a, { rot: [0, f.yaw, 0] });
    this.camPanel(gb, fx, roof + 1.25 + signW / 3.2 / 2, fz, signW, signW / 3.2, this.tile(`sign:${s.kind}`), 1.05);
    const k = this.map.roads.kerbHeight;
    // Floodlit forecourt: warm light from the door across the yard to the pad.
    const [ax, , az] = f.w(0, 0, faceZ + 4.5);
    this.decal(pb, ax, k + 0.025, az, 13, this.tile('spill'), 0xffe2b0, 0.22);
    this.decal(pb, ax, k + 0.026, az, 8, this.tile('spill'), col, 0.25);
    // The drive-in pad: ring with chevrons towards the door, glyph in the middle (upright on screen).
    const r = 5;
    this.decal(pb, s.x, k + 0.04, s.z, r * 2, this.tile('pad:drive'), col, 0.8, 0.5, Math.atan2(s.fx, s.fz));
    this.decal(pb, s.x, k + 0.05, s.z, r * 0.8, this.tile(`glyph:${s.kind}`), col, 0.75, 0.5);
  }
}
