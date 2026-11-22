import * as THREE from 'three';
import { FixedStepLoop, World, emptyIntents, lerp } from '@neonheat/sim';
import { Viewport } from '@neonheat/engine';
import { DebugPanel } from '@neonheat/ui';

export async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setClearColor(0x0b0d1a);
  const viewport = new Viewport(renderer, canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 1000);
  camera.position.set(0, 60, 35);
  camera.lookAt(0, 0, 0);
  viewport.onResize(({ width, height }) => {
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  });
  viewport.update();

  scene.add(new THREE.HemisphereLight(0x8080ff, 0x200020, 1.5));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(300, 300), new THREE.MeshLambertMaterial({ color: 0x14162a }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  const probe = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial({ color: 0x21f0ff }));
  scene.add(probe);

  const world = new World({ seed: 1 });
  const loop = new FixedStepLoop();
  const intents = emptyIntents();
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => keys.add(e.code));
  window.addEventListener('keyup', (e) => keys.delete(e.code));

  const debug = import.meta.env.DEV ? new DebugPanel() : null;
  let fps = 0;
  let tickMs = 0;
  debug?.addStat('fps', () => fps.toFixed(0));
  debug?.addStat('draw calls', () => String(renderer.info.render.calls));
  debug?.addStat('sim tick ms', () => tickMs.toFixed(3));

  let last = performance.now();
  const frame = (now: number): void => {
    const elapsed = Math.min(0.25, (now - last) / 1000);
    last = now;
    fps = lerp(fps, 1 / Math.max(elapsed, 1e-4), 0.05);
    intents.moveX = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    intents.moveY = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0);
    const alpha = loop.advance(elapsed, () => {
      const t0 = performance.now();
      world.step(intents);
      tickMs = performance.now() - t0;
    });
    const p = world.probe;
    probe.position.set(lerp(p.prevX, p.x, alpha), 0.5, lerp(p.prevZ, p.z, alpha));
    renderer.render(scene, camera);
    debug?.update(now);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
