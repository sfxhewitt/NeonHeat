import type { WebGLRenderer } from 'three';

export interface ViewportSize {
  width: number;
  height: number;
  pixelRatio: number;
}

/**
 * Keeps a renderer sized to its canvas's CSS box, with device-pixel-ratio
 * scaling and a dynamic resolution factor (0.6 to 1.0 of the device ratio).
 */
export class Viewport {
  private readonly listeners: ((size: ViewportSize) => void)[] = [];
  /** Dynamic resolution scale applied on top of the device pixel ratio. */
  resolutionScale = 1;
  /** Hard cap on the effective pixel ratio (quality tier). */
  maxPixelRatio = 2;
  size: ViewportSize = { width: 1, height: 1, pixelRatio: 1 };

  constructor(
    private readonly renderer: WebGLRenderer,
    private readonly canvas: HTMLCanvasElement,
  ) {
    const onResize = (): void => this.update();
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(onResize).observe(canvas);
    this.update();
  }

  onResize(fn: (size: ViewportSize) => void): void {
    this.listeners.push(fn);
  }

  setResolutionScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.6, scale));
    if (Math.abs(clamped - this.resolutionScale) < 0.01) return;
    this.resolutionScale = clamped;
    this.update();
  }

  update(): void {
    const width = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const height = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);
    const pixelRatio = dpr * this.resolutionScale;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
    this.size = { width, height, pixelRatio };
    for (const fn of this.listeners) fn(this.size);
  }
}
