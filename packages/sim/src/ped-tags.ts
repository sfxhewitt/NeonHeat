/**
 * Per-ped presentation and grouping data, kept in flat typed arrays indexed by
 * ped id (no allocation). The sim systems write them; the renderer reads them.
 * Every spawn resets a ped's tags.
 */

/** What a ped wears. Crew looks are LOOK_CREW + the crew's index in the gang config. */
export const Look = {
  civilian: 0,
  crew: 1,
  medic: 20,
  firefighter: 21,
} as const;

/** What a ped is doing, beyond walking (drives the renderer's pose). */
export const Anim = {
  none: 0,
  /** Kneeling over a patient. */
  kneel: 1,
  /** A nod to the player (friendly crew). */
  nod: 2,
  /** Holding a hose on a fire. */
  hose: 3,
  /** Standing at the kerb waiting to cross. */
  wait: 4,
  /** Huddled in a doorway out of the storm. */
  shelter: 5,
  /** Watching (and filming) a wreck or a fight. */
  gawk: 6,
  /** Gun up, in a fight. */
  aim: 7,
  /** Hanging about with the crew. */
  loiter: 8,
} as const;

export class PedTags {
  /** Look (see `Look`). */
  readonly look: Uint8Array;
  /** Current pose extra (see `Anim`) and seconds left on a timed one (nod). */
  readonly anim: Uint8Array;
  readonly animT: Float32Array;
  /** Walking-group leader's ped id, or -1. */
  readonly leader: Int16Array;
  /** Point the ped looks at while posing (crossings, gawking, hose). */
  readonly lookX: Float32Array;
  readonly lookZ: Float32Array;
  /** Carries a gun (gang members): the renderer puts one in their hand. */
  readonly armed: Uint8Array;
  /** A mission actor's ped (or body): emergency services leave it to the mission. */
  readonly actor: Uint8Array;

  constructor(readonly size: number) {
    this.look = new Uint8Array(size);
    this.anim = new Uint8Array(size);
    this.animT = new Float32Array(size);
    this.leader = new Int16Array(size).fill(-1);
    this.lookX = new Float32Array(size);
    this.lookZ = new Float32Array(size);
    this.armed = new Uint8Array(size);
    this.actor = new Uint8Array(size);
  }

  reset(id: number): void {
    this.look[id] = Look.civilian;
    this.anim[id] = Anim.none;
    this.animT[id] = 0;
    this.leader[id] = -1;
    this.armed[id] = 0;
    this.actor[id] = 0;
  }
}

/** Does this ped carry an umbrella when it rains? A fixed share of people, by id. */
export function hasUmbrella(pedId: number, share: number): boolean {
  return (Math.imul(pedId + 17, 2654435761) >>> 0) % 1000 < share * 1000;
}
