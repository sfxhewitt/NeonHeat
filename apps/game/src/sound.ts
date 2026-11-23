import { GameAudio, type AudioConfig } from '@neonheat/audio';
import { RadioButton, storeSettings, type Settings, type SettingsPanelHooks } from '@neonheat/ui';
import type { Game } from './game';

/**
 * Glue between the game and the sound layer: unlocking, settings, the radio button and R key,
 * mission and hack cues, and pausing on a hidden tab. Keeps game.ts to a few calls.
 */
export class SoundBridge {
  readonly audio: GameAudio;
  private radioBtn: RadioButton | null = null;
  private game: Game | null = null;
  private lastLit = -1;
  private hackSeen = false;

  constructor(
    cfg: AudioConfig,
    private readonly settings: Settings,
  ) {
    this.audio = new GameAudio(cfg);
    this.audio.applySettings(settings);
    this.audio.attach(window);
  }

  /** Extra hooks for the pause menu's Sound section. */
  menuHooks(): Pick<SettingsPanelHooks, 'stations' | 'onSoundChange' | 'onButton'> {
    return {
      stations: () => this.audio.stations,
      onSoundChange: (s, final) => {
        this.audio.applySettings(s);
        if (final) storeSettings(s);
      },
      onButton: () => this.audio.ui('blip'),
    };
  }

  /** Wire into a running game (after missions are set up). */
  attach(game: Game): void {
    this.game = game;
    const a = this.audio;
    this.radioBtn = new RadioButton(game.overlay, () => this.cycleStation());
    a.onStation = (s) => this.radioBtn?.show(s?.name ?? null, s?.frequency, s?.colour);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyR' && !e.repeat && game.world.player.vehicle) this.cycleStation();
    });
    document.addEventListener('visibilitychange', () => a.setHidden(document.hidden));

    const d = game.director;
    const onStart = d.onStart;
    d.onStart = (m) => {
      onStart?.(m);
      a.sting('missionStart');
    };
    const onComplete = d.onComplete;
    d.onComplete = (r) => {
      onComplete?.(r);
      a.sting('missionComplete');
      setTimeout(() => a.ui('cash'), 700);
    };
    const onFail = d.onFail;
    d.onFail = (reason) => {
      onFail?.(reason);
      a.sting('missionFail');
    };
    const onHackStart = d.onHackStart;
    d.onHackStart = (h) => {
      onHackStart?.(h);
      a.ui('hackStart');
    };
    const onHackEnd = d.onHackEnd;
    d.onHackEnd = (ok) => {
      onHackEnd?.(ok);
      a.ui(ok ? 'hackOk' : 'hackFail');
    };
    const hackTap = d.hackTap.bind(d);
    d.hackTap = (node) => {
      const h = d.hack;
      const before = h ? h.inputIndex : -1;
      hackTap(node);
      if (h && h.inputIndex > before) a.ui('hackGood', node);
    };
  }

  private cycleStation(): void {
    this.settings.radioStation = this.audio.nextStation();
    storeSettings(this.settings);
  }

  /** Per rendered frame. */
  frame(dt: number): void {
    const g = this.game;
    if (!g) return;
    const focus = g.rig.focus;
    this.audio.update(dt, focus.x, focus.z, g.world);
    const menuOpen = g.overlay.querySelector('.nh-modal') !== null;
    this.radioBtn?.setVisible(g.world.player.vehicle !== null && !menuOpen);
    // Hack panel: each node sounds its note as it lights up.
    const h = g.director.hack;
    const lit = h ? h.litNode : -1;
    if (lit >= 0 && lit !== this.lastLit) this.audio.ui('hackNode', lit);
    this.lastLit = lit;
    if (!h && this.hackSeen) this.lastLit = -1;
    this.hackSeen = h !== null;
  }
}
