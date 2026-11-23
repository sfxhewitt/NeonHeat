import type * as THREE from 'three';
import type { SimEvent, World } from '@neonheat/sim';
import { CombatView, type CameraRig, type Particles, type SceneLights } from '@neonheat/engine';
import { CombatHud, FateCard, type Hud, type InputManager } from '@neonheat/ui';

export interface CombatLayerDeps {
  scene: THREE.Scene;
  overlay: HTMLElement;
  hud: Hud;
  input: InputManager;
  particles: Particles;
  lights: SceneLights;
  rig: CameraRig;
  vibrate: (ms: number) => void;
}

const PICKUP_LABELS: Record<string, string> = { health: '+HEALTH', armour: '+ARMOUR' };

/**
 * The game-side half of the wanted, combat and survival layer: the vitals and
 * weapon HUD, the FLATLINED / BOOKED card, pickup and grenade rendering, and
 * the feedback for combat events. Kept out of game.ts so the wiring stays small.
 */
export class CombatLayer {
  readonly view: CombatView;
  private readonly hudView: CombatHud;
  private readonly fate: FateCard;
  private lastWeapon = '';

  constructor(
    private readonly world: World,
    private readonly d: CombatLayerDeps,
  ) {
    this.view = new CombatView(d.scene, world);
    this.hudView = new CombatHud(d.hud.root);
    this.fate = new FateCard(d.overlay);
  }

  private toast(text: string, seconds = 1.6): void {
    this.d.hud.toast(text, performance.now(), seconds);
  }

  /** Returns true when the event was handled here. */
  onEvent(e: SimEvent): boolean {
    const d = this.d;
    switch (e.type) {
      case 'explosion':
        d.particles.explosion(e.x, e.z, e.radius);
        d.lights.flash(e.x, e.z, 0xff8a3a, 0.45);
        {
          const p = this.world.player;
          const dist = Math.hypot(e.x - p.x, e.z - p.z);
          if (dist < 40) {
            d.rig.addShake(Math.max(0.2, 1.1 - dist / 40));
            d.vibrate(dist < 12 ? 60 : 25);
          }
        }
        return true;
      case 'arc':
        this.view.addArc(e.points, e.n);
        d.lights.flash(e.points[0]!, e.points[1]!, 0xb98cff, 0.12);
        return true;
      case 'melee':
        if (e.hit) {
          d.particles.burstSparks(e.hx, e.hz, e.combo >= 2 ? 6 : 3, 1);
          d.rig.addShake(e.combo >= 2 ? 0.35 : 0.18);
          d.vibrate(e.combo >= 2 ? 25 : 12);
        }
        return true;
      case 'playerWasted':
      case 'playerBusted':
        this.fate.show(e.type === 'playerWasted' ? 'flatlined' : 'booked', e.creditsLost, this.world.content.survival[e.type === 'playerWasted' ? 'flatlined' : 'booked'].loseWeapons);
        d.vibrate(120);
        return true;
      case 'playerDied':
        return true; // the FLATLINED card covers it
      case 'playerRespawned':
        this.fate.hide();
        return false; // game.ts snaps the camera
      case 'heat':
        if (e.reason === 'escape' && e.level === 0) this.toast('LOST THEM');
        else if (e.reason === 'escape') this.toast('HEAT FALLING');
        else if (e.reason === 'swap') this.toast('NEW WHEELS');
        else if (e.reason === 'respray') this.toast('RESPRAYED');
        return true;
      case 'crimeReported':
        if (e.by === 'witness') this.toast('WITNESS CALLED IT IN', 1.8);
        return true;
      case 'roadblock':
        this.toast('ROADBLOCK AHEAD');
        return true;
      case 'tyresPopped':
        if (e.vehicleId === this.world.player.vehicle?.id) {
          this.toast('TYRES BURST');
          d.rig.addShake(0.5);
          d.vibrate(50);
        }
        d.particles.burstSparks(e.x, e.z, 10, 3);
        return true;
      case 'scoreBanked':
        this.toast(`+${e.amount.toLocaleString('en-GB')} cr BANKED`, 2.2);
        return true;
      case 'respray':
        if (e.result === 'seen') this.toast('NOT WITH THEM WATCHING');
        else if (e.result === 'tooHot') this.toast('TOO HOT TO RESPRAY');
        return true;
      case 'pickup': {
        const w = this.world.content.pickups.kinds[e.kind]?.weapon;
        const name = w ? this.world.content.weapons.weapons[w]?.name : undefined;
        this.toast(PICKUP_LABELS[e.kind] ?? (name ? name.toUpperCase() : e.kind.toUpperCase()), 1.2);
        d.vibrate(15);
        return true;
      }
      case 'launch':
        d.rig.addShake(0.25);
        return true;
      default:
        return false;
    }
  }

  update(alpha: number, dt: number): void {
    const w = this.world;
    const pc = w.playerCtl;
    const c = w.combat;
    const wpn = c.weapon;
    this.view.update(w, alpha, dt, w.time);
    this.d.hud.showHealth(!!w.player.vehicle);
    this.hudView.update({
      health: pc.hp,
      maxHealth: pc.maxHp,
      armour: pc.armour,
      maxArmour: pc.maxArmour,
      weapon: c.weaponId,
      weaponName: wpn.name,
      ammo: wpn.ammoMax > 0 ? c.currentAmmo : -1,
      pending: w.score.pending,
      multiplier: w.score.multiplier,
      credits: w.score.credits,
      arrest: w.police.arrestProgress,
    });
    if (c.weaponId !== this.lastWeapon) {
      this.lastWeapon = c.weaponId;
      this.d.input.touch.setWeapon(wpn.short, wpn.driveBy);
    }
  }
}
