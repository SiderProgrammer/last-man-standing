import { Assets, Container, Graphics, Sprite, Text, Texture, type Application } from 'pixi.js';
import { Action, AttackOutcome } from '@lms/protocol';
import {
  easeOutCubic,
  progress,
  sample,
  type Beat,
  type SeatDisplay,
  type Timeline,
} from './choreography.js';
import type { Point } from './layout.js';
import { BANNER, FLOAT, FX } from './theme.js';

/**
 * The round replay's visual effects.
 *
 * Two kinds of thing live here. Some effects are *bound to the timeline* — a
 * projectile's position is a function of how far through its travel beat the
 * replay is, so it can never drift from the HP drain the arena shows. Others are
 * *fire and forget* — sparks, debris, smoke — spawned when a beat starts and left
 * to run their own short physics. Both run on one monotonic clock, so a puff of
 * smoke from the last round finishes correctly even if the next replay starts.
 *
 * Textures are the Kenney CC0 set in `public/fx/`, white with the shape in
 * alpha, tinted from `FX`. Every one of them is optional: a texture that fails
 * to load is replaced by a procedural glow, exactly as a seat without an avatar
 * keeps its plain circle. The match never depends on a picture.
 */

const TEXTURES = [
  'glow',
  'streak',
  'flash',
  'burst',
  'claw',
  'shield',
  'ring',
  'puff',
  'blast',
  'debris',
  'shockwave',
  'smoke',
  'bolt',
  'flare',
] as const;

type TextureName = (typeof TEXTURES)[number];

/** Something on screen that updates itself until it reports it is finished. */
interface Live {
  update(now: number): boolean;
  destroy(): void;
}

interface ParticleOptions {
  tint: number;
  life: number;
  sizeFrom: number;
  sizeTo: number;
  alphaFrom?: number;
  alphaTo?: number;
  vx?: number;
  vy?: number;
  gravity?: number;
  spin?: number;
  rotation?: number;
  additive?: boolean;
}

/**
 * A trigger this far behind the replay clock is dropped rather than fired.
 * Only happens when frames stop arriving — a backgrounded tab, a stalled
 * device — and firing a whole round's bursts on one frame would be noise.
 */
const STALE = 0.25;

/** Headroom above a seat's centre where floating numbers start. */
const FLOAT_ORIGIN = -26;
const FLOAT_RISE = 26;
const FLOAT_LIFE = 0.8;
/** Vertical spacing between numbers that land on one seat at the same time. */
const FLOAT_STACK = 16;
/** How far an attacker leans toward its target while declaring. */
const LUNGE = 10;
/** How far a hider steps aside when a blow misses. */
const SIDESTEP = 12;
/** Projectiles bow sideways so two seats trading blows do not overlap. */
const ARC = 18;

export class Effects {
  readonly layer = new Container();

  private readonly live: Live[] = [];
  private readonly pool: Sprite[] = [];
  private readonly floats = new Map<number, number>();
  /**
   * Wall-clock seconds, read once per frame. Deliberately not accumulated from
   * frame deltas: the server's replay hold runs on real time, and a clock built
   * from clamped deltas falls behind it whenever frames are slow, which would
   * let the replay spill into the next commit window.
   */
  private now = wallClock();

  private timeline: Timeline | null = null;
  private replayStart = 0;
  private triggers: Array<{ at: number; fire: () => void }> = [];
  /** When each seat's shield or shimmer should drop. */
  private guardUntil = new Map<number, number>();
  private shakeUntil = 0;
  private shakeStrength = 0;
  private winner: Live | null = null;

  private constructor(
    private readonly textures: Record<TextureName, Texture>,
    private readonly positionOf: (seat: number) => Point | null,
    private readonly reduced: boolean,
  ) {}

  /**
   * Loads the textures, substituting a generated glow for any that fail.
   *
   * `allSettled` rather than `all`: one missing file must cost exactly that one
   * effect its look, not take every other texture down with it.
   */
  static async create(app: Application, positionOf: (seat: number) => Point | null): Promise<Effects> {
    const fallback = app.renderer.generateTexture(softGlow());
    const base = import.meta.env.BASE_URL ?? '/';

    const loaded = await Promise.allSettled(
      TEXTURES.map((name) => Assets.load<Texture>(`${base}fx/${name}.png`)),
    );

    const textures = {} as Record<TextureName, Texture>;
    TEXTURES.forEach((name, index) => {
      const result = loaded[index];
      if (result?.status === 'fulfilled') {
        textures[name] = result.value;
      } else {
        console.warn(`[fx] ${name}.png unavailable, using a generated glow`);
        textures[name] = fallback;
      }
    });

    return new Effects(textures, positionOf, prefersReducedMotion());
  }

  /** True while a replay is playing, which is when the arena defers to `sample`. */
  get replaying(): boolean {
    return this.timeline !== null && this.replayTime <= this.timeline.duration;
  }

  /** Seconds into the current replay. */
  get replayTime(): number {
    return this.now - this.replayStart;
  }

  /** What every seat should show right now, or null outside a replay. */
  sampleNow(): Map<number, SeatDisplay> | null {
    return this.timeline ? sample(this.timeline, this.replayTime) : null;
  }

  /** Starts a replay. Anything still lingering from the last one finishes normally. */
  play(timeline: Timeline): void {
    this.timeline = timeline;
    this.replayStart = this.now;
    this.guardUntil.clear();

    // Shields and shimmers hold until every blow of the round has landed.
    const combat = new Set<Beat['kind']>(['declare', 'travel', 'impact', 'riposte']);
    const combatEnd = Math.max(
      0,
      ...timeline.beats.filter((beat) => combat.has(beat.kind)).map((beat) => beat.end),
    );

    this.triggers = timeline.beats
      .flatMap((beat) => this.triggersFor(beat, combatEnd))
      .sort((a, b) => a.at - b.at);
  }

  /** Drops the replay and every effect, for a new match. */
  clear(): void {
    this.timeline = null;
    this.triggers = [];
    this.guardUntil.clear();
    for (const effect of this.live.splice(0)) effect.destroy();
    this.winner?.destroy();
    this.winner = null;
    this.floats.clear();
  }

  /** Advances every effect. Called from the arena's ticker. */
  update(): void {
    this.now = wallClock();

    const t = this.replayTime;
    while (this.triggers.length > 0 && (this.triggers[0]?.at ?? Infinity) <= t) {
      const trigger = this.triggers.shift();
      // Late by more than a beat means frames stopped arriving; the HP drain
      // still lands correctly because `sample` reads the same clock.
      if (trigger && t - trigger.at <= STALE) trigger.fire();
    }

    for (let index = this.live.length - 1; index >= 0; index -= 1) {
      const effect = this.live[index];
      if (effect && !effect.update(this.now)) {
        effect.destroy();
        this.live.splice(index, 1);
      }
    }
    this.winner?.update(this.now);

    if (this.timeline && t > this.timeline.duration) this.timeline = null;
  }

  /**
   * How far a seat is displaced this frame: a lunge while declaring an attack,
   * a sidestep when a blow misses it. Zero under reduced motion.
   */
  seatOffset(seat: number): Point {
    const timeline = this.timeline;
    if (!timeline || this.reduced) return { x: 0, y: 0 };

    const t = this.replayTime;
    let x = 0;
    let y = 0;
    for (const beat of timeline.beats) {
      if (beat.kind === 'declare' && beat.seat === seat && beat.action === Action.Attack) {
        const push = Math.sin(Math.PI * progress(t, beat)) * LUNGE;
        const toward = this.direction(seat, beat.target);
        x += toward.x * push;
        y += toward.y * push;
      } else if (beat.kind === 'impact' && beat.seat === seat && beat.outcome === AttackOutcome.Missed) {
        const step = Math.sin(Math.PI * progress(t, beat)) * SIDESTEP;
        const away = this.direction(beat.from, seat);
        // Perpendicular to the blow: a dodge, not a retreat.
        x += -away.y * step;
        y += away.x * step;
      }
    }
    return { x, y };
  }

  /** Opacity multiplier for a seat: hiders shimmer until the blows are in. */
  seatAlpha(seat: number): number {
    const until = this.guardUntil.get(seat);
    if (until === undefined || this.replayTime > until || this.reduced) return 1;
    const hiding = this.timeline?.beats.some(
      (beat) => beat.kind === 'declare' && beat.seat === seat && beat.action === Action.Hide,
    );
    return hiding ? 0.55 + 0.12 * Math.sin(this.now * 18) : 1;
  }

  /** Screen shake for the current frame, applied by the arena to its world. */
  shake(): Point {
    if (this.now >= this.shakeUntil || this.reduced) return { x: 0, y: 0 };
    const left = (this.shakeUntil - this.now) / 0.18;
    const strength = this.shakeStrength * left;
    return {
      x: (Math.random() * 2 - 1) * strength,
      y: (Math.random() * 2 - 1) * strength,
    };
  }

  /** 0..1, peaking mid-storm, so the arena can flare the storm ring. */
  stormFlare(): number {
    const storm = this.timeline?.storm;
    if (!storm) return 0;
    return Math.sin(Math.PI * progress(this.replayTime, storm));
  }

  /** Crowns the last seat standing. Persists until the next match. */
  showWinner(seat: number): void {
    const at = this.positionOf(seat);
    if (!at) return;
    this.winner?.destroy();

    if (!this.reduced) {
      this.burstOf(at, 16, { tint: FX.winner, life: 0.9, size: 12, speed: [70, 180] });
      this.particle('ring', at, {
        tint: FX.winner,
        life: 0.8,
        sizeFrom: 50,
        sizeTo: 170,
        alphaFrom: 0.9,
        additive: true,
      });
    }

    const flare = this.acquire('flare', FX.winner, true);
    flare.position.set(at.x, at.y);
    const banner = new Text({ text: 'LAST ONE STANDING', style: BANNER });
    banner.anchor.set(0.5);
    banner.position.set(at.x, at.y - 78);
    this.layer.addChild(banner);

    const born = this.now;
    this.winner = {
      update: (now) => {
        const age = now - born;
        const pulse = this.reduced ? 0 : Math.sin(age * 3) * 0.08;
        size(flare, 130 * (1 + pulse));
        flare.alpha = Math.min(0.85, age * 3);
        flare.rotation = this.reduced ? 0 : age * 0.4;
        banner.alpha = Math.min(1, age * 2.5);
        return true;
      },
      destroy: () => {
        this.release(flare);
        banner.destroy();
      },
    };
  }

  // ------------------------------------------------------------------ triggers

  private triggersFor(beat: Beat, combatEnd: number): Array<{ at: number; fire: () => void }> {
    switch (beat.kind) {
      case 'noShow':
        return [{ at: beat.start, fire: () => this.noShow(beat.seat) }];
      case 'declare':
        return beat.action === Action.Defend || beat.action === Action.Hide
          ? [{ at: beat.start, fire: () => this.guard(beat.seat, beat.action, combatEnd) }]
          : [];
      case 'travel':
        return [{ at: beat.start, fire: () => this.projectile(beat.from, beat.to, beat, FX.projectile) }];
      case 'impact':
        return [{ at: beat.start, fire: () => this.impact(beat) }];
      case 'riposte':
        return [
          { at: beat.start, fire: () => this.projectile(beat.from, beat.to, beat, FX.parry) },
          { at: beat.end, fire: () => this.riposteLands(beat.to, beat.damage) },
        ];
      case 'storm':
        return [{ at: beat.start, fire: () => this.storm(beat.seat, beat.damage) }];
      case 'eliminate':
        return [{ at: beat.start, fire: () => this.eliminate(beat.seat) }];
    }
  }

  private noShow(seat: number): void {
    const at = this.positionOf(seat);
    if (!at) return;
    if (!this.reduced) {
      this.particle('puff', at, {
        tint: FX.noShow,
        life: 0.7,
        sizeFrom: 40,
        sizeTo: 80,
        alphaFrom: 0.6,
        vy: -18,
      });
    }
    this.floatText(seat, 'no show', FX.noShow);
  }

  /** A defender's shield, or a hider's shimmer, held until the blows are in. */
  private guard(seat: number, action: number, until: number): void {
    this.guardUntil.set(seat, until);
    if (action !== Action.Defend || this.reduced) return;

    const at = this.positionOf(seat);
    if (!at) return;
    const shield = this.acquire('ring', FX.parry, true);
    shield.position.set(at.x, at.y);
    const born = this.now;
    const drop = this.replayStart + until;

    this.live.push({
      update: (now) => {
        const rise = Math.min(1, (now - born) / 0.15);
        const fall = now > drop ? 1 - Math.min(1, (now - drop) / 0.15) : 1;
        shield.alpha = 0.55 * rise * fall;
        size(shield, 92 + Math.sin(now * 6) * 2);
        return fall > 0;
      },
      destroy: () => this.release(shield),
    });
  }

  /** A projectile bound to a beat's window, so it lands exactly on its impact. */
  private projectile(from: number, to: number, window: { start: number; end: number }, tint: number): void {
    if (this.reduced) return;
    const a = this.positionOf(from);
    const b = this.positionOf(to);
    if (!a || !b) return;

    const head = this.acquire('glow', tint, true);
    const trail = this.acquire('streak', tint, true);
    size(head, 26);
    const start = this.replayStart + window.start;
    const end = this.replayStart + window.end;
    const normal = { x: -(b.y - a.y), y: b.x - a.x };
    const length = Math.hypot(normal.x, normal.y) || 1;

    this.live.push({
      update: (now) => {
        const p = progress(now, { start, end });
        const bow = Math.sin(Math.PI * p) * ARC;
        const x = a.x + (b.x - a.x) * p + (normal.x / length) * bow;
        const y = a.y + (b.y - a.y) * p + (normal.y / length) * bow;
        // Velocity of the curve, so the trail points along the path it is
        // actually taking rather than along the straight line.
        const lead = Math.min(1, p + 0.02);
        const bowLead = Math.sin(Math.PI * lead) * ARC;
        const nx = a.x + (b.x - a.x) * lead + (normal.x / length) * bowLead;
        const ny = a.y + (b.y - a.y) * lead + (normal.y / length) * bowLead;

        head.position.set(x, y);
        trail.position.set(x, y);
        trail.rotation = Math.atan2(ny - y, nx - x) + Math.PI / 2;
        size(trail, 70);
        trail.alpha = 0.75;
        return p < 1;
      },
      destroy: () => {
        this.release(head);
        this.release(trail);
      },
    });
  }

  private impact(beat: Extract<Beat, { kind: 'impact' }>): void {
    const at = this.positionOf(beat.seat);
    if (!at) return;

    if (beat.outcome === AttackOutcome.Hit) {
      if (!this.reduced) {
        this.particle('flash', at, { tint: FX.hit, life: 0.25, sizeFrom: 30, sizeTo: 90, additive: true });
        this.particle('burst', at, { tint: FX.hit, life: 0.35, sizeFrom: 40, sizeTo: 75, additive: true });
        this.particle('claw', at, {
          tint: 0xffffff,
          life: 0.45,
          sizeFrom: 58,
          sizeTo: 62,
          rotation: Math.random() * Math.PI * 2,
          additive: true,
        });
        this.burstOf(at, 6, { tint: FX.hit, life: 0.35, size: 10, speed: [90, 170] });
      }
      this.floatText(beat.seat, `-${beat.damage}`, FX.hit);
      return;
    }

    if (beat.outcome === AttackOutcome.Parried) {
      if (!this.reduced) {
        this.particle('ring', at, {
          tint: FX.parry,
          life: 0.35,
          sizeFrom: 60,
          sizeTo: 110,
          alphaFrom: 1,
          additive: true,
        });
        this.particle('flash', at, { tint: FX.parry, life: 0.2, sizeFrom: 20, sizeTo: 55, additive: true });
      }
      this.floatText(beat.seat, 'parry', FX.parry);
      return;
    }

    if (beat.outcome === AttackOutcome.Missed) {
      if (!this.reduced) {
        this.particle('puff', at, {
          tint: FX.miss,
          life: 0.55,
          sizeFrom: 30,
          sizeTo: 64,
          alphaFrom: 0.7,
          vy: -14,
        });
      }
      this.floatText(beat.seat, 'miss', FX.miss);
    }
  }

  private riposteLands(seat: number, damage: number): void {
    const at = this.positionOf(seat);
    if (!at) return;
    if (!this.reduced) {
      this.particle('flash', at, { tint: FX.parry, life: 0.22, sizeFrom: 22, sizeTo: 60, additive: true });
      this.burstOf(at, 4, { tint: FX.parry, life: 0.3, size: 8, speed: [70, 130] });
    }
    this.floatText(seat, `-${damage}`, FX.parry);
  }

  private storm(seat: number, damage: number): void {
    const at = this.positionOf(seat);
    if (!at) return;
    if (!this.reduced) {
      this.particle('bolt', { x: at.x, y: at.y - 34 }, {
        tint: FX.storm,
        life: 0.35,
        sizeFrom: 80,
        sizeTo: 80,
        alphaFrom: 1,
        additive: true,
      });
      this.particle('glow', at, { tint: FX.storm, life: 0.3, sizeFrom: 40, sizeTo: 70, additive: true });
    }
    this.floatText(seat, `-${damage}`, FX.storm);
  }

  /** The kill. The one moment in the replay that is allowed to be loud. */
  private eliminate(seat: number): void {
    const at = this.positionOf(seat);
    if (!at) return;

    if (!this.reduced) {
      this.particle('blast', at, { tint: FX.kill, life: 0.45, sizeFrom: 40, sizeTo: 130, additive: true });
      this.particle('shockwave', at, {
        tint: FX.kill,
        life: 0.5,
        sizeFrom: 40,
        sizeTo: 180,
        alphaFrom: 0.9,
        additive: true,
      });
      for (let index = 0; index < 10; index += 1) {
        const angle = (index / 10) * Math.PI * 2 + Math.random() * 0.5;
        const speed = 90 + Math.random() * 100;
        this.particle('debris', at, {
          tint: 0x9a8f82,
          life: 0.6 + Math.random() * 0.3,
          sizeFrom: 18 + Math.random() * 10,
          sizeTo: 6,
          alphaFrom: 1,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 40,
          gravity: 260,
          spin: (Math.random() * 2 - 1) * 6,
          rotation: Math.random() * Math.PI * 2,
        });
      }
      this.particle('smoke', at, {
        tint: 0x6b7280,
        life: 0.9,
        sizeFrom: 50,
        sizeTo: 115,
        alphaFrom: 0.5,
        vy: -16,
      });
      this.shakeUntil = this.now + 0.18;
      this.shakeStrength = 6;
    }
    this.floatText(seat, 'OUT', FX.kill);
  }

  // ------------------------------------------------------------------ helpers

  private particle(name: TextureName, at: Point, options: ParticleOptions): void {
    const sprite = this.acquire(name, options.tint, options.additive ?? false);
    const born = this.now;
    const from = options.alphaFrom ?? 1;
    const to = options.alphaTo ?? 0;
    let x = at.x;
    let y = at.y;
    const vx = options.vx ?? 0;
    // Only the vertical velocity changes, because gravity is the only force.
    let vy = options.vy ?? 0;
    let last = born;
    sprite.rotation = options.rotation ?? 0;

    this.live.push({
      update: (now) => {
        const age = now - born;
        const p = Math.min(1, age / options.life);
        const dt = now - last;
        last = now;

        vy += (options.gravity ?? 0) * dt;
        x += vx * dt;
        y += vy * dt;
        sprite.position.set(x, y);
        sprite.rotation += (options.spin ?? 0) * dt;
        size(sprite, options.sizeFrom + (options.sizeTo - options.sizeFrom) * easeOutCubic(p));
        sprite.alpha = from + (to - from) * p;
        return p < 1;
      },
      destroy: () => this.release(sprite),
    });
    // Place it immediately, so it does not sit at the origin for one frame.
    sprite.position.set(x, y);
    size(sprite, options.sizeFrom);
    sprite.alpha = from;
  }

  /** A radial spray of small glowing sparks. */
  private burstOf(
    at: Point,
    count: number,
    options: { tint: number; life: number; size: number; speed: [number, number] },
  ): void {
    for (let index = 0; index < count; index += 1) {
      const angle = (index / count) * Math.PI * 2 + Math.random() * 0.6;
      const speed = options.speed[0] + Math.random() * (options.speed[1] - options.speed[0]);
      this.particle('glow', at, {
        tint: options.tint,
        life: options.life,
        sizeFrom: options.size,
        sizeTo: 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        additive: true,
      });
    }
  }

  /**
   * A number or word rising off a seat. Several landing on one seat at once —
   * a hit and a riposte, say — stack upward instead of printing over each other.
   */
  private floatText(seat: number, text: string, tint: number): void {
    const at = this.positionOf(seat);
    if (!at) return;

    const slot = this.floats.get(seat) ?? 0;
    this.floats.set(seat, slot + 1);

    const label = new Text({ text, style: { ...FLOAT, fill: tint } });
    label.anchor.set(0.5);
    this.layer.addChild(label);
    const born = this.now;
    const baseY = at.y + FLOAT_ORIGIN - slot * FLOAT_STACK;

    const step = (now: number) => {
      const p = Math.min(1, (now - born) / FLOAT_LIFE);
      label.position.set(at.x, baseY - easeOutCubic(p) * FLOAT_RISE);
      label.alpha = p < 0.55 ? 1 : 1 - (p - 0.55) / 0.45;
      label.scale.set(0.7 + 0.3 * Math.min(1, p / 0.15));
      return p < 1;
    };
    step(born);

    this.live.push({
      update: step,
      destroy: () => {
        label.destroy();
        const left = (this.floats.get(seat) ?? 1) - 1;
        if (left <= 0) this.floats.delete(seat);
        else this.floats.set(seat, left);
      },
    });
  }

  private direction(from: number, to: number): Point {
    const a = this.positionOf(from);
    const b = this.positionOf(to);
    if (!a || !b) return { x: 0, y: 0 };
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: dx / length, y: dy / length };
  }

  /** Sprites are pooled: a busy round spawns dozens of them for half a second. */
  private acquire(name: TextureName, tint: number, additive: boolean): Sprite {
    const sprite = this.pool.pop() ?? new Sprite();
    sprite.texture = this.textures[name];
    sprite.anchor.set(0.5);
    sprite.tint = tint;
    sprite.blendMode = additive ? 'add' : 'normal';
    sprite.alpha = 1;
    sprite.rotation = 0;
    sprite.visible = true;
    this.layer.addChild(sprite);
    return sprite;
  }

  private release(sprite: Sprite): void {
    sprite.removeFromParent();
    this.pool.push(sprite);
  }
}

/** Sets a sprite's rendered size, whatever the resolution of its texture. */
function size(sprite: Sprite, pixels: number): void {
  const width = sprite.texture.width || 1;
  sprite.scale.set(pixels / width);
}

/** The procedural stand-in for any texture that fails to load. */
function softGlow(): Graphics {
  const glow = new Graphics();
  for (let ring = 16; ring >= 1; ring -= 1) {
    glow.circle(0, 0, ring * 4).fill({ color: 0xffffff, alpha: 0.06 });
  }
  return glow;
}

function wallClock(): number {
  return performance.now() / 1000;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
