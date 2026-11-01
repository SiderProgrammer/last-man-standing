import 'pixi.js/math-extras';
import { Container, Graphics, Point, Sprite, Text, type Application, type Texture } from 'pixi.js';
import { Action, StrikeOutcome } from '@lms/consensus';
import type { FxTextures } from '../assets/loader.js';
import { FX_TEXTURES, type FxTexture } from '../assets/manifest.js';
import { gsap } from '../motion.js';
import type { Beat, Timeline, Window } from './choreography.js';
import type { Point as PointLike, StormRing } from './layout.js';
import { RECIPES, type Puff, type Recipe, type Spray } from './recipes.js';
import type { Replay, SeatDisplay } from './replay.js';
import { FLOAT, FX, TITLE } from './theme.js';

/**
 * The round replay's visual effects, all of them GSAP tweens.
 *
 * Two kinds. Effects that must line up with the round — a projectile arriving
 * on its impact, a shield dropping when the last blow lands, a lunge — are
 * placed on the replay's own timeline, so they cannot drift from the HP drain
 * the arena shows. Effects that merely decorate a moment — sparks, debris,
 * smoke, floating numbers — are spawned when that moment is reached and left
 * to run; what each moment spawns is data, in `recipes.ts`. They live in one
 * `gsap.context`, so `clear()` stops all of them at once.
 *
 * Textures come from the asset loader. Any that failed to load is replaced by
 * a generated glow, exactly as a seat without an avatar keeps its plain circle.
 */

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
const FLOAT_STACK = 22;
/** How far a striker leans toward its target while declaring. */
const LUNGE = 10;
/** Projectiles bow sideways, so two seats trading blows do not overlap. */
const ARC = 18;
const SHIELD_SIZE = 92;
const SHIELD_FADE = 0.15;
/** Half a breath of a charging seat's pulse. */
const SHIMMER = 0.175;
/** How far the camera pushes in on a kill. */
const ZOOM_PUNCH = 1.045;
/** Longest hit-stop, in real seconds, and the margin it always leaves the hold. */
const MAX_HIT_STOP = 0.1;
const HOLD_MARGIN = 0.15;
/** Timeline speed during a hit-stop: nearly frozen, not quite. */
const HIT_STOP_SCALE = 0.05;

export interface EffectsOptions {
  app: Application;
  textures: FxTextures;
  positionOf: (seat: number) => PointLike | null;
  /** Shaken as a whole when a blow lands. */
  world: Container;
  /** Zoomed about the arena's centre on a kill. */
  camera: Container;
  /** Where the arena wall is now, for the stall penalty's bolts that leap off it. */
  storm: () => StormRing | null;
}

export class Effects {
  readonly layer = new Container();
  /** Full-screen flashes, above everything and outside the shake. */
  readonly overlay = new Graphics();

  private readonly textures: Record<FxTexture, Texture>;
  /** Drawn here for any texture that failed to load, so it is this object's to free. */
  private readonly fallback: Texture;
  private readonly pool: Sprite[] = [];
  /** Sprites currently on screen, so `clear` can recover any a killed timeline stranded. */
  private readonly active = new Set<Sprite>();
  private readonly floats = new Map<number, number>();
  private readonly reduced = prefersReducedMotion();
  /** Owns every fire-and-forget tween. */
  private context = gsap.context(() => {});
  /** Real seconds of hit-stop the current replay may still spend. */
  private stopBudget = 0;

  constructor(private readonly options: EffectsOptions) {
    this.overlay.alpha = 0;
    this.overlay.eventMode = 'none';
    this.fallback = options.app.renderer.generateTexture(softGlow());
    this.textures = Object.fromEntries(
      FX_TEXTURES.map((name) => [name, options.textures[name] ?? this.fallback]),
    ) as Record<FxTexture, Texture>;
  }

  /**
   * Adds the round's effects to its replay timeline.
   *
   * Called before the timeline plays, so every effect is scheduled against the
   * same clock as the HP drain it illustrates. `holdSeconds` is the server's
   * hold before the next round: the only time a hit-stop may borrow, and only
   * what the choreography leaves of it.
   */
  decorate(replay: Replay, choreo: Timeline, holdSeconds = 0): void {
    const { timeline, seats } = replay;
    const spare = (holdSeconds - choreo.duration - HOLD_MARGIN) / (1 - HIT_STOP_SCALE);
    this.stopBudget = this.reduced ? 0 : gsap.utils.clamp(0, MAX_HIT_STOP, spare);
    this.when(timeline, 0, () => this.title(`ROUND ${replay.round}`, 0xdbe3f0));
    if (choreo.stall) {
      this.when(timeline, choreo.stall.start, () => {
        this.screenFlash(FX.storm, 0.16);
        this.title('STALL', FX.storm, 0.6);
      });
    }

    // Shields and charge-ups hold until every blow of the round has landed.
    const combat = new Set<Beat['kind']>(['declare', 'travel', 'impact', 'reflect', 'heal']);
    const combatEnd = Math.max(
      0,
      ...choreo.beats.filter((beat) => combat.has(beat.kind)).map((beat) => beat.end),
    );

    for (const beat of choreo.beats) {
      switch (beat.kind) {
        case 'noShow':
          this.when(timeline, beat.start, () => this.moment(beat.seat, RECIPES.noShow, 'no show', FX.noShow));
          break;
        case 'declare':
          if (beat.action === Action.Strike) {
            this.sway(timeline, seats.get(beat.seat), this.direction(beat.seat, beat.target), LUNGE, beat);
            this.when(timeline, beat.start, () => this.moment(beat.seat, RECIPES.windup));
          } else if (beat.action === Action.Guard) {
            this.shield(timeline, beat.seat, beat.start, combatEnd);
          } else if (beat.action === Action.Charge) {
            this.shimmer(timeline, seats.get(beat.seat), beat.start, combatEnd);
            this.when(timeline, beat.start, () => this.moment(beat.seat, RECIPES.charging, 'CHARGING', FX.charge));
          }
          break;
        case 'travel':
          this.projectile(timeline, beat.from, beat.to, beat, beat.charged ? FX.charge : FX.projectile);
          break;
        case 'impact':
          this.when(timeline, beat.start, () => this.impact(beat));
          break;
        case 'heal':
          this.when(timeline, beat.start, () => this.moment(beat.seat, RECIPES.heal, `+${beat.amount}`, FX.heal));
          break;
        case 'reflect':
          this.projectile(timeline, beat.from, beat.to, beat, FX.parry);
          this.when(timeline, beat.end, () =>
            this.moment(beat.to, RECIPES.reflect, `REFLECT -${beat.damage}`, FX.parry),
          );
          break;
        case 'stall':
          this.when(timeline, beat.start, () => {
            this.lightning(beat.seat);
            this.moment(beat.seat, RECIPES.storm, `-${beat.damage}`, FX.storm);
          });
          break;
        case 'eliminate':
          this.when(timeline, beat.start, () => {
            this.hitStop(timeline);
            this.zoomPunch();
            this.moment(beat.seat, RECIPES.eliminate, 'ELIMINATED', FX.kill, 1.2);
          });
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
    this.options.world.position.set(0, 0);
    this.options.camera.scale.set(1);
    this.overlay.alpha = 0;
  }

  /**
   * Frees what the arena's own teardown would miss: pooled sprites are off
   * the stage, so destroying the stage does not reach them, and the fallback
   * texture was generated here. The loaded textures are the asset cache's,
   * shared with the next arena, and stay.
   */
  destroy(): void {
    this.clear();
    for (const sprite of this.pool) sprite.destroy();
    this.pool.length = 0;
    this.fallback.destroy(true);
  }

  /** Crowns the last seat standing. Persists until the next match. */
  showWinner(seat: number): void {
    const at = this.options.positionOf(seat);
    if (!at) return;

    this.context.add(() => {
      this.play(RECIPES.winner, at);

      const flare = this.acquire('flare', FX.winner, true);
      flare.position.set(at.x, at.y);
      flare.alpha = 0;
      flare.scale.set(this.scaleFor(flare, 130));
      gsap.to(flare, { alpha: 0.85, duration: 0.3 });
      if (!this.reduced) gsap.to(flare, { rotation: Math.PI * 2, duration: 16, repeat: -1, ease: 'none' });

      // Across the middle of the floor rather than over the seat, where a
      // winner on the top of the ring would push it off the canvas.
      const centre = this.options.storm()?.centre ?? at;
      const banner = new Text({
        text: `LAST ONE STANDING\nSEAT #${seat}`,
        style: { ...TITLE, fill: FX.winner, align: 'center' },
      });
      banner.anchor.set(0.5);
      banner.position.set(centre.x, centre.y);
      banner.alpha = 0;
      this.layer.addChild(banner);
      gsap.to(banner, { alpha: 1, duration: 0.4 });
      gsap.fromTo(
        banner.scale,
        { x: this.reduced ? 0.62 : 1, y: this.reduced ? 0.62 : 1 },
        {
          x: 0.62,
          y: 0.62,
          duration: 0.5,
          ease: 'back.out(2)',
        },
      );
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

  /** A guard's bubble, raised on declaring and dropped once the blows are in; its twirl turns. */
  private shield(timeline: gsap.core.Timeline, seat: number, from: number, until: number): void {
    const at = this.options.positionOf(seat);
    if (!at || this.reduced) return;

    for (const [texture, alpha, turn] of [
      ['ring', 0.55, 0],
      ['shield', 0.35, Math.PI * 1.5],
    ] as const) {
      const sprite = this.acquire(texture, FX.parry, true);
      sprite.position.set(at.x, at.y);
      sprite.alpha = 0;
      sprite.scale.set(this.scaleFor(sprite, SHIELD_SIZE));
      timeline
        .to(sprite, { alpha, duration: SHIELD_FADE }, from)
        .to(sprite, { rotation: turn, duration: until - from + SHIELD_FADE, ease: 'none' }, from)
        .to(sprite, { alpha: 0, duration: SHIELD_FADE }, until)
        .call(() => this.release(sprite), undefined, until + SHIELD_FADE);
    }
  }

  /** A charging seat pulsing until the blows are in. */
  private shimmer(
    timeline: gsap.core.Timeline,
    seat: SeatDisplay | undefined,
    from: number,
    until: number,
  ): void {
    if (!seat || this.reduced) return;
    // Whole breaths only, so the flicker finishes on or before the blows land.
    const repeat = Math.max(0, Math.floor((until - from) / SHIMMER) - 1);
    timeline
      .fromTo(
        seat,
        { veil: 0.67 },
        { veil: 0.43, duration: SHIMMER, ease: 'sine.inOut', yoyo: true, repeat, immediateRender: false },
        from,
      )
      .set(seat, { veil: 1 }, until);
  }

  /** A projectile curving from one seat to another, landing exactly on its impact. */
  private projectile(
    timeline: gsap.core.Timeline,
    from: number,
    to: number,
    window: Window,
    tint: number,
  ): void {
    const a = this.options.positionOf(from);
    const b = this.options.positionOf(to);
    if (!a || !b || this.reduced) return;

    // A coloured head with a white-hot core, trailing a streak.
    const bolt = new Container();
    bolt.visible = false;
    const parts = (
      [
        ['glow', tint, 34],
        ['glow', 0xffffff, 12],
        ['streak', tint, 84],
      ] as const
    ).map(([texture, colour, size]) => {
      const sprite = this.acquire(texture, colour, true, bolt);
      sprite.scale.set(this.scaleFor(sprite, size));
      return sprite;
    });
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
          ease: 'power1.in',
        },
        window.start,
      )
      .call(
        () => {
          for (const sprite of parts) this.release(sprite);
          bolt.destroy();
        },
        undefined,
        window.end,
      );
  }

  // --------------------------------------------------------------- moments

  private impact(beat: Extract<Beat, { kind: 'impact' }>): void {
    if (beat.outcome === StrikeOutcome.Hit && beat.charged)
      this.moment(beat.seat, RECIPES.chargedHit, `-${beat.damage}`, FX.charge, 1.5);
    else if (beat.outcome === StrikeOutcome.Hit) this.moment(beat.seat, RECIPES.hit, `-${beat.damage}`, FX.hit, 1.25);
    else if (beat.outcome === StrikeOutcome.Guarded) this.moment(beat.seat, RECIPES.block, 'BLOCK', FX.parry);
  }

  /** A moment on one seat: its recipe, and the word or number that rises off it. */
  private moment(seat: number, recipe: Recipe, text?: string, tint: number = FX.miss, size = 1): void {
    const at = this.options.positionOf(seat);
    if (!at) return;
    this.play(recipe, at);
    if (text) this.floatText(seat, at, text, tint, size);
  }

  /** Spawns a recipe's sprites, shake and flash. Pure decoration, so none of it under reduced motion. */
  private play(recipe: Recipe, at: PointLike): void {
    if (this.reduced) return;
    for (const puff of recipe.puffs ?? []) this.puff(puff, at);
    for (const spray of recipe.sprays ?? []) this.spray(spray, at);
    if (recipe.shake) this.shake(...recipe.shake);
    if (recipe.flash) this.screenFlash(...recipe.flash);
  }

  private puff(puff: Puff, at: PointLike): void {
    const sprite = this.acquire(puff.texture, puff.tint, puff.additive ?? false);
    sprite.position.set(at.x, at.y);
    sprite.rotation = puff.randomTurn ? gsap.utils.random(0, Math.PI * 2) : 0;
    this.fade(sprite, puff.life, puff.size, puff.alpha ?? 1, {
      ...(puff.rise ? { physics2D: { velocity: puff.rise, angle: -90 } } : {}),
      ...(puff.spin ? { rotation: `+=${puff.spin}` } : {}),
    });
  }

  private spray(spray: Spray, at: PointLike): void {
    const [low, high] = spray.angles ?? [0, 360];
    for (let piece = 0; piece < spray.count; piece += 1) {
      const tint = Array.isArray(spray.tint) ? gsap.utils.random(spray.tint) : spray.tint;
      const sprite = this.acquire(spray.texture, tint, spray.additive ?? false);
      sprite.position.set(at.x, at.y);
      sprite.rotation = gsap.utils.random(0, Math.PI * 2);
      this.fade(sprite, gsap.utils.random(...spray.life), spray.size, 1, {
        physics2D: {
          velocity: gsap.utils.random(...spray.speed),
          angle: gsap.utils.random(low, high),
          gravity: spray.gravity ?? 0,
        },
        ...(spray.spin ? { rotation: `+=${gsap.utils.random(-spray.spin, spray.spin)}` } : {}),
      });
    }
  }

  /** Sizes a sprite from one width to another while it fades out, with any extra motion alongside. */
  private fade(
    sprite: Sprite,
    life: number,
    [from, to]: readonly [number, number],
    alpha: number,
    motion: gsap.TweenVars,
  ): void {
    gsap
      .timeline({ onComplete: () => this.release(sprite) })
      .fromTo(
        sprite.scale,
        { x: this.scaleFor(sprite, from), y: this.scaleFor(sprite, from) },
        {
          x: this.scaleFor(sprite, to),
          y: this.scaleFor(sprite, to),
          duration: life,
          ease: 'power2.out',
        },
        0,
      )
      .fromTo(sprite, { alpha }, { alpha: 0, duration: life, ease: 'none', ...motion }, 0);
  }

  /**
   * Freezes the replay for a beat on the round's first kill. Borrows only the
   * hold the choreography left unused, so the replay still ends in time.
   */
  private hitStop(timeline: gsap.core.Timeline): void {
    const stop = this.stopBudget;
    if (stop <= 0) return;
    this.stopBudget = 0;
    timeline.timeScale(HIT_STOP_SCALE);
    gsap.delayedCall(stop, () => timeline.timeScale(1));
  }

  private zoomPunch(): void {
    if (this.reduced) return;
    gsap.fromTo(
      this.options.camera.scale,
      { x: ZOOM_PUNCH, y: ZOOM_PUNCH },
      { x: 1, y: 1, duration: 0.45, ease: 'power3.out', overwrite: true },
    );
  }

  /** Quick jolts of the whole world to random offsets, then back to rest. */
  private shake(amount: number, jolts: number): void {
    const { world } = this.options;
    gsap.fromTo(
      world,
      { x: 0, y: 0 },
      {
        x: `random(${-amount}, ${amount})`,
        y: `random(${-amount}, ${amount})`,
        duration: 0.03,
        repeat: jolts - 1,
        yoyo: true,
        repeatRefresh: true,
        ease: 'none',
        overwrite: true,
        onComplete: () => world.position.set(0, 0),
      },
    );
  }

  /** A wash of colour over the whole arena, gone in a blink. */
  private screenFlash(tint: number, strength: number): void {
    if (this.reduced) return;
    const { width, height } = this.options.app.screen;
    this.overlay.clear().rect(0, 0, width, height).fill(tint);
    gsap.fromTo(
      this.overlay,
      { alpha: strength },
      { alpha: 0, duration: 0.35, ease: 'power2.out', overwrite: true },
    );
  }

  /** A big word across the middle of the floor: the round number, the stall. */
  private title(text: string, tint: number, size = 1): void {
    const centre = this.options.storm()?.centre;
    if (!centre) return;
    const label = new Text({ text, style: { ...TITLE, fill: tint } });
    label.anchor.set(0.5);
    label.position.set(centre.x, centre.y);
    label.alpha = 0;
    this.layer.addChildAt(label, 0);

    const grow = this.reduced ? size : size * 1.35;
    gsap
      .timeline({ onComplete: () => label.destroy() })
      .fromTo(label.scale, { x: grow, y: grow }, { x: size, y: size, duration: 0.25, ease: 'power3.out' }, 0)
      .to(label, { alpha: 0.9, duration: 0.15 }, 0)
      .to(label, { alpha: 0, duration: 0.35, ease: 'power1.in' }, 0.65);
  }

  /** A bolt from the arena wall down onto a seat: the streak texture, stretched between them. */
  private lightning(seat: number): void {
    const storm = this.options.storm();
    const at = this.options.positionOf(seat);
    if (!storm || !at || this.reduced) return;
    const angle = Math.atan2(at.y - storm.centre.y, at.x - storm.centre.x);
    const length = storm.radius - Math.hypot(at.x - storm.centre.x, at.y - storm.centre.y);
    const strike = this.acquire('streak', FX.storm, true);
    // The streak runs vertically in its texture, so it is turned a quarter past the angle.
    strike.rotation = angle + Math.PI / 2;
    strike.position.set(at.x + (Math.cos(angle) * length) / 2, at.y + (Math.sin(angle) * length) / 2);
    strike.scale.set(this.scaleFor(strike, 40), Math.abs(length) / strike.texture.height);
    gsap
      .timeline({ onComplete: () => this.release(strike) })
      .to(strike, { alpha: 0.3, duration: 0.05, yoyo: true, repeat: 2, ease: 'none' })
      .to(strike, { alpha: 0, duration: 0.2 });
  }

  // ------------------------------------------------------------- building blocks

  /**
   * A number or word rising off a seat. Several landing on one seat at once —
   * a hit and a reflection, say — stack upward instead of printing over each other.
   */
  private floatText(seat: number, at: PointLike, text: string, tint: number, size: number): void {
    const slot = this.floats.get(seat) ?? 0;
    this.floats.set(seat, slot + 1);

    const label = new Text({ text, style: { ...FLOAT, fill: tint } });
    label.anchor.set(0.5);
    label.position.set(at.x, at.y + FLOAT_ORIGIN - slot * FLOAT_STACK);
    this.layer.addChild(label);

    const pop = this.reduced ? size : size * 1.7;
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
      // Pops in oversized and settles, so a number lands like a blow.
      .fromTo(
        label.scale,
        { x: pop, y: pop },
        { x: size, y: size, duration: FLOAT_LIFE * 0.3, ease: 'back.out(2.5)' },
        0,
      )
      // Holds for the first half of its life, then fades.
      .to(label, { alpha: 0, duration: FLOAT_LIFE * 0.45, ease: 'none' }, FLOAT_LIFE * 0.55);
  }

  /** Unit vector from one seat toward another. */
  private direction(from: number, to: number): Point {
    const a = this.options.positionOf(from);
    const b = this.options.positionOf(to);
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

/** The procedural stand-in for any texture that fails to load. */
export function softGlow(): Graphics {
  const glow = new Graphics();
  for (let ring = 16; ring >= 1; ring -= 1) {
    glow.circle(0, 0, ring * 4).fill({ color: 0xffffff, alpha: 0.06 });
  }
  return glow;
}

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
