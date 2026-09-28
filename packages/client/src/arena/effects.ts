import 'pixi.js/math-extras';
import { Container, Graphics, Point, Sprite, Text, type Application, type Texture } from 'pixi.js';
import { Action, AttackOutcome } from '@lms/protocol';
import type { FxTextures } from '../assets/loader.js';
import { FX_TEXTURES, type FxTexture } from '../assets/manifest.js';
import { gsap } from '../motion.js';
import type { Beat, Timeline, Window } from './choreography.js';
import type { Point as PointLike } from './layout.js';
import type { Replay, SeatDisplay } from './replay.js';
import { BANNER, FLOAT, FX } from './theme.js';

/**
 * The round replay's visual effects, all of them GSAP tweens.
 *
 * Two kinds. Effects that must line up with the round — a projectile arriving
 * on its impact, a shield dropping when the last blow lands, a lunge — are
 * placed on the replay's own timeline, so they cannot drift from the HP drain
 * the arena shows. Effects that merely decorate a moment — sparks, debris,
 * smoke, floating numbers — are spawned when that moment is reached and left
 * to run; they live in one `gsap.context`, so `clear()` stops all of them at
 * once.
 *
 * Textures come from the asset loader. Any that failed to load is replaced by
 * a generated glow, exactly as a seat without an avatar keeps its plain circle.
 */

interface ParticleOptions {
  tint: number;
  life: number;
  sizeFrom: number;
  sizeTo: number;
  alphaFrom?: number;
  alphaTo?: number;
  /** Launch speed in pixels per second, for `Physics2DPlugin`. */
  velocity?: number;
  /** Launch direction in degrees: 0 is right, 90 is down. */
  angle?: number;
  gravity?: number;
  /** Radians turned over the particle's life. */
  spin?: number;
  rotation?: number;
  additive?: boolean;
}

/**
 * A moment reached this long after it was due is skipped, not played. Only
 * happens when frames stop arriving — a backgrounded tab, a stalled device —
 * and firing a whole round's bursts on one frame would be noise.
 */
const STALE = 0.25;

const FLOAT_ORIGIN = -26;
const FLOAT_RISE = 26;
const FLOAT_LIFE = 0.8;
/** Vertical spacing between numbers that land on one seat at once. */
const FLOAT_STACK = 16;
/** How far an attacker leans toward its target while declaring. */
const LUNGE = 10;
/** How far a hider steps aside when a blow misses. */
const SIDESTEP = 12;
/** Projectiles bow sideways, so two seats trading blows do not overlap. */
const ARC = 18;
const SHIELD_SIZE = 92;
const SHIELD_ALPHA = 0.55;
const SHIELD_FADE = 0.15;
/** Half a breath of the shield's pulse, and of a hider's shimmer. */
const SHIELD_PULSE = 0.52;
const SHIMMER = 0.175;
const SHAKE = 6;

export class Effects {
  readonly layer = new Container();

  private readonly textures: Record<FxTexture, Texture>;
  private readonly pool: Sprite[] = [];
  /** Sprites currently on screen, so `clear` can recover any a killed timeline stranded. */
  private readonly active = new Set<Sprite>();
  private readonly floats = new Map<number, number>();
  private readonly reduced = prefersReducedMotion();
  /** Owns every fire-and-forget tween. */
  private context = gsap.context(() => {});

  constructor(
    app: Application,
    loaded: FxTextures,
    private readonly positionOf: (seat: number) => PointLike | null,
    /** Shaken as a whole when a seat is eliminated. */
    private readonly world: Container,
  ) {
    const fallback = app.renderer.generateTexture(softGlow());
    this.textures = Object.fromEntries(
      FX_TEXTURES.map((name) => [name, loaded[name] ?? fallback]),
    ) as Record<FxTexture, Texture>;
  }

  /**
   * Adds the round's effects to its replay timeline.
   *
   * Called before the timeline plays, so every effect is scheduled against the
   * same clock as the HP drain it illustrates.
   */
  decorate(replay: Replay, choreo: Timeline): void {
    const { timeline, seats } = replay;
    // Shields and shimmers hold until every blow of the round has landed.
    const combat = new Set<Beat['kind']>(['declare', 'travel', 'impact', 'riposte']);
    const combatEnd = Math.max(
      0,
      ...choreo.beats.filter((beat) => combat.has(beat.kind)).map((beat) => beat.end),
    );

    for (const beat of choreo.beats) {
      switch (beat.kind) {
        case 'noShow':
          this.when(timeline, beat.start, () => this.noShow(beat.seat));
          break;
        case 'declare':
          if (beat.action === Action.Attack) {
            this.sway(timeline, seats.get(beat.seat), this.direction(beat.seat, beat.target), LUNGE, beat);
          } else if (beat.action === Action.Defend) {
            this.shield(timeline, beat.seat, beat.start, combatEnd);
          } else if (beat.action === Action.Hide) {
            this.shimmer(timeline, seats.get(beat.seat), beat.start, combatEnd);
          }
          break;
        case 'travel':
          this.projectile(timeline, beat.from, beat.to, beat, FX.projectile);
          break;
        case 'impact':
          this.when(timeline, beat.start, () => this.impact(beat));
          if (beat.outcome === AttackOutcome.Missed) {
            // Perpendicular to the blow: a dodge, not a retreat.
            const blow = this.direction(beat.from, beat.seat);
            this.sway(timeline, seats.get(beat.seat), new Point(-blow.y, blow.x), SIDESTEP, beat);
          }
          break;
        case 'riposte':
          this.projectile(timeline, beat.from, beat.to, beat, FX.parry);
          this.when(timeline, beat.end, () => this.riposteLands(beat.to, beat.damage));
          break;
        case 'storm':
          this.when(timeline, beat.start, () => this.storm(beat.seat, beat.damage));
          break;
        case 'eliminate':
          this.when(timeline, beat.start, () => this.eliminate(beat.seat));
          break;
      }
    }
  }

  /** Stops every effect and returns every sprite, for a new match. */
  clear(): void {
    this.context.kill();
    this.context = gsap.context(() => {});
    for (const sprite of [...this.active]) this.release(sprite);
    // What is left is labels and emptied projectile containers; none is pooled.
    for (const child of this.layer.removeChildren()) child.destroy();
    this.floats.clear();
    this.world.position.set(0, 0);
  }

  /** Crowns the last seat standing. Persists until the next match. */
  showWinner(seat: number): void {
    const at = this.positionOf(seat);
    if (!at) return;

    this.context.add(() => {
      if (!this.reduced) {
        this.burst(at, 16, { tint: FX.winner, life: 0.9, size: 12, speed: [70, 180] });
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
      flare.alpha = 0;
      const size = this.scaleFor(flare, 130);
      flare.scale.set(size);
      gsap.to(flare, { alpha: 0.85, duration: 0.3 });

      const banner = new Text({ text: 'LAST ONE STANDING', style: BANNER });
      banner.anchor.set(0.5);
      banner.position.set(at.x, at.y - 78);
      banner.alpha = 0;
      this.layer.addChild(banner);
      gsap.to(banner, { alpha: 1, duration: 0.4 });

      if (!this.reduced) {
        gsap.to(flare, { rotation: Math.PI * 2, duration: 16, repeat: -1, ease: 'none' });
        gsap.to(flare.scale, {
          x: size * 1.08,
          y: size * 1.08,
          duration: 1,
          yoyo: true,
          repeat: -1,
          ease: 'sine.inOut',
        });
      }
    });
  }

  // --------------------------------------------------------- on the timeline

  /**
   * Fires a moment's effects when the replay reaches it, unless the replay only
   * got there by jumping far past it.
   */
  private when(timeline: gsap.core.Timeline, at: number, fire: () => void): void {
    timeline.call(
      () => {
        if (timeline.time() - at <= STALE) this.context.add(fire);
      },
      undefined,
      at,
    );
  }

  /** A seat leaning out and back along a direction: a lunge or a sidestep. */
  private sway(
    timeline: gsap.core.Timeline,
    seat: SeatDisplay | undefined,
    direction: Point,
    distance: number,
    window: Window,
  ): void {
    if (!seat || this.reduced) return;
    const reach = direction.multiplyScalar(distance);
    // `sine.out` up, mirrored by the yoyo on the way back: one arch, which
    // leaves the seat exactly home when the beat ends.
    timeline.to(
      seat,
      { dx: reach.x, dy: reach.y, duration: span(window) / 2, ease: 'sine.out', yoyo: true, repeat: 1 },
      window.start,
    );
  }

  /** A defender's shield, raised on declaring and dropped once the blows are in. */
  private shield(timeline: gsap.core.Timeline, seat: number, from: number, until: number): void {
    if (this.reduced) return;
    const at = this.positionOf(seat);
    if (!at) return;

    const ring = this.acquire('ring', FX.parry, true);
    ring.position.set(at.x, at.y);
    ring.alpha = 0;
    const size = this.scaleFor(ring, SHIELD_SIZE);
    ring.scale.set(size);

    timeline
      .to(ring, { alpha: SHIELD_ALPHA, duration: SHIELD_FADE }, from)
      .to(
        ring.scale,
        {
          x: size * 1.02,
          y: size * 1.02,
          duration: SHIELD_PULSE,
          ease: 'sine.inOut',
          yoyo: true,
          repeat: breaths(until - from, SHIELD_PULSE),
        },
        from,
      )
      .to(ring, { alpha: 0, duration: SHIELD_FADE }, until)
      .call(() => this.release(ring), undefined, until + SHIELD_FADE);
  }

  /** A hider flickering until the blows are in. */
  private shimmer(timeline: gsap.core.Timeline, seat: SeatDisplay | undefined, from: number, until: number): void {
    if (!seat || this.reduced) return;
    timeline
      .fromTo(
        seat,
        { veil: 0.67 },
        {
          veil: 0.43,
          duration: SHIMMER,
          ease: 'sine.inOut',
          yoyo: true,
          repeat: breaths(until - from, SHIMMER),
          immediateRender: false,
        },
        from,
      )
      .set(seat, { veil: 1 }, until);
  }

  /** A projectile curving from one seat to another, landing exactly on its impact. */
  private projectile(timeline: gsap.core.Timeline, from: number, to: number, window: Window, tint: number): void {
    if (this.reduced) return;
    const a = this.positionOf(from);
    const b = this.positionOf(to);
    if (!a || !b) return;

    const bolt = new Container();
    bolt.visible = false;
    const head = this.acquire('glow', tint, true, bolt);
    const trail = this.acquire('streak', tint, true, bolt);
    head.scale.set(this.scaleFor(head, 26));
    trail.scale.set(this.scaleFor(trail, 70));
    trail.alpha = 0.75;
    this.layer.addChild(bolt);

    const start = new Point(a.x, a.y);
    const end = new Point(b.x, b.y);
    const along = end.subtract(start).normalize();
    const middle = start.add(end).multiplyScalar(0.5).add(new Point(-along.y, along.x).multiplyScalar(ARC));

    timeline
      .set(bolt, { visible: true }, window.start)
      .to(
        bolt,
        {
          motionPath: {
            // Plain objects: the plugin reads a path point's fields by enumerating them.
            path: [start, middle, end].map(({ x, y }) => ({ x, y })),
            fromCurrent: false,
            curviness: 1,
            // Turns the trail to lie along the curve, not the straight line.
            autoRotate: Math.PI / 2,
            useRadians: true,
          },
          duration: span(window),
          ease: 'none',
        },
        window.start,
      )
      .call(
        () => {
          this.release(head);
          this.release(trail);
          bolt.destroy();
        },
        undefined,
        window.end,
      );
  }

  // --------------------------------------------------------------- moments

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
        velocity: 18,
        angle: -90,
      });
    }
    this.floatText(seat, 'no show', FX.noShow);
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
          rotation: gsap.utils.random(0, Math.PI * 2),
          additive: true,
        });
        this.burst(at, 6, { tint: FX.hit, life: 0.35, size: 10, speed: [90, 170] });
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
          velocity: 14,
          angle: -90,
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
      this.burst(at, 4, { tint: FX.parry, life: 0.3, size: 8, speed: [70, 130] });
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
        this.particle('debris', at, {
          tint: 0x9a8f82,
          life: gsap.utils.random(0.6, 0.9),
          sizeFrom: gsap.utils.random(18, 28),
          sizeTo: 6,
          alphaFrom: 1,
          velocity: gsap.utils.random(90, 190),
          angle: index * 36 + gsap.utils.random(0, 28),
          gravity: 260,
          spin: gsap.utils.random(-6, 6),
          rotation: gsap.utils.random(0, Math.PI * 2),
        });
      }
      this.particle('smoke', at, {
        tint: 0x6b7280,
        life: 0.9,
        sizeFrom: 50,
        sizeTo: 115,
        alphaFrom: 0.5,
        velocity: 16,
        angle: -90,
      });
      // Five quick jolts to random offsets, then back to rest.
      gsap.fromTo(
        this.world,
        { x: 0, y: 0 },
        {
          x: `random(${-SHAKE}, ${SHAKE})`,
          y: `random(${-SHAKE}, ${SHAKE})`,
          duration: 0.03,
          repeat: 5,
          yoyo: true,
          repeatRefresh: true,
          ease: 'none',
          overwrite: true,
          onComplete: () => this.world.position.set(0, 0),
        },
      );
    }
    this.floatText(seat, 'OUT', FX.kill);
  }

  // ------------------------------------------------------------- building blocks

  private particle(name: FxTexture, at: PointLike, options: ParticleOptions): void {
    const sprite = this.acquire(name, options.tint, options.additive ?? false);
    sprite.position.set(at.x, at.y);
    sprite.rotation = options.rotation ?? 0;
    const from = this.scaleFor(sprite, options.sizeFrom);
    const to = this.scaleFor(sprite, options.sizeTo);

    const life = gsap.timeline({ onComplete: () => this.release(sprite) });
    life
      .fromTo(sprite.scale, { x: from, y: from }, { x: to, y: to, duration: options.life, ease: 'power2.out' }, 0)
      .fromTo(
        sprite,
        { alpha: options.alphaFrom ?? 1 },
        { alpha: options.alphaTo ?? 0, duration: options.life, ease: 'none' },
        0,
      );
    if (options.velocity) {
      life.to(
        sprite,
        {
          physics2D: {
            velocity: options.velocity,
            angle: options.angle ?? 0,
            gravity: options.gravity ?? 0,
          },
          duration: options.life,
        },
        0,
      );
    }
    if (options.spin) {
      life.to(sprite, { rotation: `+=${options.spin}`, duration: options.life, ease: 'none' }, 0);
    }
  }

  /** A radial spray of small glowing sparks, spread evenly with a little jitter. */
  private burst(
    at: PointLike,
    count: number,
    options: { tint: number; life: number; size: number; speed: [number, number] },
  ): void {
    const step = 360 / count;
    for (let index = 0; index < count; index += 1) {
      this.particle('glow', at, {
        tint: options.tint,
        life: options.life,
        sizeFrom: options.size,
        sizeTo: 2,
        velocity: gsap.utils.random(...options.speed),
        angle: index * step + gsap.utils.random(0, 34),
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
    label.position.set(at.x, at.y + FLOAT_ORIGIN - slot * FLOAT_STACK);
    this.layer.addChild(label);

    gsap
      .timeline({
        onComplete: () => {
          label.destroy();
          const left = (this.floats.get(seat) ?? 1) - 1;
          if (left <= 0) this.floats.delete(seat);
          else this.floats.set(seat, left);
        },
      })
      .to(label, { y: `-=${FLOAT_RISE}`, duration: FLOAT_LIFE, ease: 'power2.out' }, 0)
      .fromTo(label.scale, { x: 0.7, y: 0.7 }, { x: 1, y: 1, duration: FLOAT_LIFE * 0.15 }, 0)
      // Holds for the first half of its life, then fades.
      .to(label, { alpha: 0, duration: FLOAT_LIFE * 0.45, ease: 'none' }, FLOAT_LIFE * 0.55);
  }

  /** Unit vector from one seat toward another. */
  private direction(from: number, to: number): Point {
    const a = this.positionOf(from);
    const b = this.positionOf(to);
    if (!a || !b || (a.x === b.x && a.y === b.y)) return new Point(0, 0);
    return new Point(b.x, b.y).subtract(new Point(a.x, a.y)).normalize();
  }

  /** Scale that renders a sprite `pixels` wide, whatever its texture's resolution. */
  private scaleFor(sprite: Sprite, pixels: number): number {
    return pixels / (sprite.texture.width || 1);
  }

  /** Sprites are pooled: a busy round spawns dozens of them for half a second. */
  private acquire(name: FxTexture, tint: number, additive: boolean, parent: Container = this.layer): Sprite {
    const sprite = this.pool.pop() ?? new Sprite();
    sprite.texture = this.textures[name];
    sprite.anchor.set(0.5);
    sprite.tint = tint;
    sprite.blendMode = additive ? 'add' : 'normal';
    sprite.alpha = 1;
    sprite.rotation = 0;
    sprite.position.set(0, 0);
    sprite.visible = true;
    parent.addChild(sprite);
    this.active.add(sprite);
    return sprite;
  }

  private release(sprite: Sprite): void {
    if (!this.active.delete(sprite)) return;
    gsap.killTweensOf([sprite, sprite.scale]);
    sprite.removeFromParent();
    this.pool.push(sprite);
  }
}

function span(window: Window): number {
  return window.end - window.start;
}

/**
 * How many times a yoyo of half-period `half` repeats inside `length` seconds,
 * so it finishes on or before the moment its effect is meant to end.
 */
function breaths(length: number, half: number): number {
  return Math.max(0, Math.floor(length / half) - 1);
}

/** The procedural stand-in for any texture that fails to load. */
function softGlow(): Graphics {
  const glow = new Graphics();
  for (let ring = 16; ring >= 1; ring -= 1) {
    glow.circle(0, 0, ring * 4).fill({ color: 0xffffff, alpha: 0.06 });
  }
  return glow;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
