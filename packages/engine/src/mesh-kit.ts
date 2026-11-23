import { BufferAttribute, BufferGeometry, Color, Euler, Matrix4, Quaternion, Vector3 } from 'three';

/**
 * A tiny low-poly modelling kit: builds flat-shaded, vertex-coloured meshes
 * from boxes, wedges and prisms, merged into one BufferGeometry so a whole
 * model is one instanced draw call. Vertex colour white = "paint" (tinted by
 * the instance colour); other colours are fixed trim (glass, tyres, chrome).
 */
export class MeshBuilder {
  private readonly pos: number[] = [];
  private readonly col: number[] = [];
  /** 1 where the vertex is paint (white), 0 for fixed trim: lets a material tint only the paint. */
  private readonly mask: number[] = [];
  private readonly m = new Matrix4();
  private readonly q = new Quaternion();
  private readonly e = new Euler();
  private readonly v = new Vector3();
  private readonly c = new Color();

  /**
   * A box from 8 corners. `top` lets the top face be narrower/shorter (a
   * tapered or sloped block): [frontInset, backInset, sideInset] in metres,
   * where front is +Z.
   */
  box(
    cx: number,
    cy: number,
    cz: number,
    w: number,
    h: number,
    d: number,
    colour: number,
    opts: { top?: [number, number, number]; rot?: [number, number, number]; shadeTop?: number } = {},
  ): this {
    const [fi, bi, si] = opts.top ?? [0, 0, 0];
    const hw = w / 2;
    const hd = d / 2;
    // Bottom corners then top corners: (x, y, z)
    const p: [number, number, number][] = [
      [-hw, 0, -hd],
      [hw, 0, -hd],
      [hw, 0, hd],
      [-hw, 0, hd],
      [-hw + si, h, -hd + bi],
      [hw - si, h, -hd + bi],
      [hw - si, h, hd - fi],
      [-hw + si, h, hd - fi],
    ];
    const faces: [number, number, number, number, number][] = [
      // a, b, c, d (CCW from outside), shade
      [4, 7, 6, 5, opts.shadeTop ?? 1.15], // top
      [0, 1, 2, 3, 0.4], // bottom
      [3, 2, 6, 7, 0.95], // front +Z
      [1, 0, 4, 5, 0.75], // back -Z
      [2, 1, 5, 6, 0.85], // right +X
      [0, 3, 7, 4, 0.85], // left -X
    ];
    this.e.set(...(opts.rot ?? [0, 0, 0]));
    this.q.setFromEuler(this.e);
    this.m.compose(this.v.set(cx, cy - h / 2, cz), this.q, new Vector3(1, 1, 1));
    const base = this.c.setHex(colour);
    const paint = colour === 0xffffff ? 1 : 0;
    for (const [a, b, c2, d2, shade] of faces) {
      for (const idx of [a, b, c2, a, c2, d2]) {
        const [x, y, z] = p[idx]!;
        this.v.set(x, y, z).applyMatrix4(this.m);
        this.pos.push(this.v.x, this.v.y, this.v.z);
        this.mask.push(paint);
        this.col.push(base.r * shade, base.g * shade, base.b * shade);
      }
    }
    return this;
  }

  /** An n-sided prism along X (wheels), centred at (cx, cy, cz). */
  cylinderX(cx: number, cy: number, cz: number, radius: number, width: number, sides: number, colour: number, capColour = colour): this {
    const base = new Color(colour);
    const cap = new Color(capColour);
    const hw = width / 2;
    const ring: [number, number][] = [];
    for (let i = 0; i < sides; i++) {
      const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
      ring.push([Math.cos(a) * radius, Math.sin(a) * radius]);
    }
    const push = (x: number, y: number, z: number, c: Color, s: number): void => {
      this.pos.push(cx + x, cy + y, cz + z);
      this.mask.push(c === base ? (colour === 0xffffff ? 1 : 0) : capColour === 0xffffff ? 1 : 0);
      this.col.push(c.r * s, c.g * s, c.b * s);
    };
    for (let i = 0; i < sides; i++) {
      const [y0, z0] = ring[i]!;
      const [y1, z1] = ring[(i + 1) % sides]!;
      const s = 0.6 + 0.4 * Math.max(0, (y0 + y1) / (2 * radius));
      // tread
      push(hw, y0, z0, base, s);
      push(hw, y1, z1, base, s);
      push(-hw, y1, z1, base, s);
      push(hw, y0, z0, base, s);
      push(-hw, y1, z1, base, s);
      push(-hw, y0, z0, base, s);
      // caps
      push(hw, 0, 0, cap, 0.9);
      push(hw, y1, z1, cap, 0.9);
      push(hw, y0, z0, cap, 0.9);
      push(-hw, 0, 0, cap, 0.9);
      push(-hw, y0, z0, cap, 0.9);
      push(-hw, y1, z1, cap, 0.9);
    }
    return this;
  }

  /** Triangles added so far (budget checks). */
  get triangles(): number {
    return this.pos.length / 9;
  }

  build(): BufferGeometry {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('color', new BufferAttribute(new Float32Array(this.col), 3));
    g.setAttribute('paintMask', new BufferAttribute(new Float32Array(this.mask), 1));
    g.computeVertexNormals();
    return g;
  }
}
