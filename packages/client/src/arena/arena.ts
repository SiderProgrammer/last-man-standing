// Pixi compiles its shader uploaders with `new Function` unless this is loaded
// first; the page's Content-Security-Policy allows no `eval` (see `csp.ts`).
import 'pixi.js/unsafe-eval';
import { Application, Container, FillGradient, Graphics, Text, type Texture } from 'pixi.js';
import {
  Action,
  MatchPhase,
  quietRounds,
  stallDamageFor,
  type ActionValue,
  type AvatarEntry,
  type PublicMatchState,
  type RoundRecord,
} from '@lms/protocol';
import { defaultAvatar } from '../assets/avatars.js';
import { loadAssets, type FxTextures } from '../assets/loader.js';
import { gsap } from '../motion.js';
import { choreograph } from './choreography.js';
import { Effects, prefersReducedMotion, softGlow } from './effects.js';
import { HP_ARC_RADIUS, centreOf, seatPosition, stormRing, type Point } from './layout.js';
import { buildReplay, DEAD_FADE, type Replay, type SeatDisplay } from './replay.js';
import { HALO_RADIUS, SeatToken, dashedRing } from './seat.js';
import { Storm } from './storm.js';
import { COLORS, HUD, HUD_VALUE } from './theme.js';

/** A move the player has picked but not yet seen resolved. Local only. */
export interface Aim {
  action: ActionValue;
  target: number;
}

/**
 * The Pixi view of a match.
 *
 * The arena renders only what the server published, so it can never leak a move
 * that has not been revealed: during the commit phase a seat shows *that* it
 * has committed, never what it committed to. The one exception is your own
 * draft — the aim line and reticle — which never leaves this browser.
 *
 * While a round is being replayed, the arena deliberately shows *less* than it
 * knows. The post-round snapshot arrives a few milliseconds after the round
 * record, and painting it would snap every HP arc and grey out every casualty
 * before the replay could show how it happened. So for the length of the replay
 * each seat is drawn from the replay's `SeatDisplay` — values a GSAP timeline is
 * tweening — and the snapshot takes over again once the replay has finished.
 */
export class Arena {
  /** Called when the player clicks a seat they could target. */
  onPick: ((seat: number) => void) | null = null;

  private readonly seats = new Map<number, SeatToken>();
  /** Zooms about the centre for the replay's big moments. */
  private readonly camera = new Container();
  /** Everything that shakes together when a blow lands. */
  private readonly world = new Container();
  private readonly floor = new Graphics();
  private readonly storm: Storm;
  private readonly seatLayer = new Container();
  private readonly hudRound = new Text({ text: '', style: HUD_VALUE });
  private readonly hudStorm = new Text({ text: '', style: { ...HUD, fill: COLORS.stormEdge } });
  private readonly effects: Effects;
  private readonly glow: Texture;
  private readonly reduced = prefersReducedMotion();

  // Your own pick, drawn on the floor. Built once; GSAP keeps them moving.
  private readonly aimLine = new Graphics();
  private readonly reticle = new Graphics()
    .circle(0, 0, HALO_RADIUS)
    .stroke({ width: 2, color: COLORS.aim, alpha: 0.9 })
    .moveTo(0, -HALO_RADIUS - 7)
    .lineTo(0, -HALO_RADIUS + 7)
    .moveTo(0, HALO_RADIUS - 7)
    .lineTo(0, HALO_RADIUS + 7)
    .moveTo(-HALO_RADIUS - 7, 0)
    .lineTo(-HALO_RADIUS + 7, 0)
    .moveTo(HALO_RADIUS - 7, 0)
    .lineTo(HALO_RADIUS + 7, 0)
    .stroke({ width: 3, color: COLORS.aim, cap: 'round' });
  private readonly guard = new Graphics()
    .circle(0, 0, HALO_RADIUS + 6)
    .stroke({ width: 3, color: COLORS.parried });
  private readonly veil = dashedRing(HALO_RADIUS + 6, 20, 0.35).stroke({ width: 2, color: COLORS.hpLow });

  private state: PublicMatchState | null = null;
  private you: number | null = null;
  private aim: Aim | null = null;
  /** Whether your aim is already sealed: it is then drawn quieter. */
  private aimSealed = false;
  /** The most recent round replayed, whether or not it is still playing. */
  private replay: Replay | null = null;

  private constructor(
    private readonly app: Application,
    textures: FxTextures,
  ) {
    this.glow = textures.glow ?? app.renderer.generateTexture(softGlow());
    this.storm = new Storm(this.reduced);
    this.effects = new Effects({
      app,
      textures,
      positionOf: (seat) => this.seats.get(seat)?.home ?? null,
      world: this.world,
      camera: this.camera,
      storm: () => (this.state ? stormRing(app.screen.width, app.screen.height, stallPressure(this.state)) : null),
    });

    const hud = new Container();
    const hudLabel = new Text({ text: 'ROUND', style: HUD });
    hudLabel.position.set(18, 14);
    this.hudRound.position.set(18, 28);
    this.hudStorm.position.set(18, 58);
    hud.addChild(hudLabel, this.hudRound, this.hudStorm);

    const aimLayer = new Container();
    aimLayer.addChild(this.aimLine, this.reticle, this.guard, this.veil);
    this.world.addChild(this.floor, this.storm.layer, aimLayer, this.seatLayer, this.effects.layer);
    this.camera.addChild(this.world);
    app.stage.addChild(this.camera, hud, this.effects.overlay);
    app.ticker.add(() => this.paint());
    app.renderer.on('resize', () => this.layout());

    if (!this.reduced) {
      gsap.to(this.reticle, { rotation: Math.PI * 2, duration: 8, repeat: -1, ease: 'none' });
      gsap.to(this.reticle.scale, {
        x: 1.06,
        y: 1.06,
        duration: 0.5,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
      });
      gsap.to(this.veil, { rotation: -Math.PI * 2, duration: 7, repeat: -1, ease: 'none' });
      gsap.to(this.guard.scale, {
        x: 1.05,
        y: 1.05,
        duration: 0.6,
        yoyo: true,
        repeat: -1,
        ease: 'sine.inOut',
      });
    }
  }

  static async mount(element: HTMLElement): Promise<Arena> {
    const app = new Application();
    await app.init({
      background: COLORS.background,
      antialias: true,
      resizeTo: element,
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
    });
    element.appendChild(app.canvas);

    // Normally already resolved: loading starts at boot, behind the loading
    // screen, long before anyone opens a match.
    return new Arena(app, await loadAssets());
  }

  render(state: PublicMatchState, you: number | null): void {
    // A different match: nothing from the last one's replay belongs here.
    if (this.state && this.state.matchId !== state.matchId) {
      this.replay?.timeline.kill();
      this.replay = null;
      this.effects.clear();
      for (const seat of this.seats.values()) seat.destroy();
      this.seats.clear();
    }
    this.state = state;
    this.you = you;

    for (const player of state.players) {
      if (this.seats.has(player.index)) continue;
      const seat = new SeatToken(player.index, player.chainId, this.glow, this.reduced, () =>
        this.onPick?.(player.index),
      );
      this.seatLayer.addChild(seat.root);
      this.seats.set(player.index, seat);
      void seat.wear(defaultAvatar(player.address), false);
    }

    this.layout();
  }

  /**
   * Shows the move the player has picked: the aim line and reticle for a
   * strike, a ring for a guard, a crackling halo for a charge. Purely local —
   * nothing here comes from or goes to the server.
   */
  setAim(aim: Aim | null, sealed: boolean, pickable: readonly number[]): void {
    this.aim = aim;
    this.aimSealed = sealed;
    for (const [index, seat] of this.seats) seat.pickable = pickable.includes(index);
  }

  /** Swaps in the NFT avatars the server resolved, over the generated faces. */
  setAvatars(entries: readonly AvatarEntry[]): void {
    for (const entry of entries) {
      if (entry.image) void this.seats.get(entry.seat)?.wear(entry.image, true);
    }
  }

  /**
   * Replays a resolved round.
   *
   * Must be called *before* the post-round snapshot is rendered: the replay
   * starts from the HP the arena is currently showing, which at this moment is
   * still the state the round began with. `holdMs` is how long the server
   * waits before the next round; the replay never runs past it.
   */
  showRound(record: RoundRecord, holdMs = 0): void {
    const before = this.state?.players.map((player) => ({
      index: player.index,
      hp: player.hp,
      alive: player.alive,
    }));
    if (!before) return;

    const choreo = choreograph(record, before, this.state?.rules.startingHp);
    const replay = buildReplay(record.round, choreo);
    this.effects.decorate(replay, choreo, holdMs / 1000);
    // The previous round's timeline is left to finish on its own: anything of
    // it still in flight lands normally, it just no longer drives the seats.
    this.replay = replay;
    replay.timeline.play();
  }

  /** Crowns the winner once the final round's replay has played out. */
  /**
   * Plays a round of a finished match again, from the table as it stood
   * before it. Whatever is on screen — a replay in flight, the winner's
   * banner — is cleared first: it belongs to a later point in the match.
   */
  rewindTo(before: PublicMatchState, record: RoundRecord): void {
    this.replay?.timeline.kill();
    this.replay = null;
    this.effects.clear();
    this.render(before, this.you);
    this.showRound(record);
  }

  showWinner(seat: number): void {
    this.effects.showWinner(seat);
  }

  destroy(): void {
    this.replay?.timeline.kill();
    this.effects.clear();
    this.storm.destroy();
    for (const seat of this.seats.values()) seat.destroy();
    gsap.killTweensOf([this.reticle, this.reticle.scale, this.veil, this.guard.scale]);
    this.app.destroy(true, { children: true });
  }

  /**
   * Where each seat's appearance comes from right now: the replay, or null for
   * the published snapshot.
   *
   * The replay rules while it plays. Once it has finished, the post-round
   * snapshot is normally already here and takes over — except after the final
   * round, which no snapshot ever follows. Handing back then would show the
   * state from *before* that round, refilling every HP arc and reviving the
   * casualties, so the replay's final frame stays until a later round arrives.
   */
  private get display(): Map<number, SeatDisplay> | null {
    const replay = this.replay;
    if (!replay) return null;
    if (isPlaying(replay)) return replay.seats;
    return (this.state?.round ?? 0) <= replay.round ? replay.seats : null;
  }

  private layout(): void {
    const { width, height } = this.app.screen;
    const centre = centreOf(width, height);
    this.camera.pivot.set(centre.x, centre.y);
    this.camera.position.set(centre.x, centre.y);

    const state = this.state;
    const count = state?.players.length ?? 0;
    state?.players.forEach((player, position) => {
      const seat = this.seats.get(player.index);
      if (seat) seat.home = seatPosition(position, count, width, height, true);
    });
    this.paintFloor(centre, Math.max(width, height));
  }

  /** The floor: lit in the middle, with the seat track etched into it. */
  private paintFloor(centre: Point, size: number): void {
    const first = this.seats.values().next().value;
    const track = first ? Math.hypot(first.home.x - centre.x, first.home.y - centre.y) : 0;
    const gradient = new FillGradient({
      type: 'radial',
      colorStops: [
        { offset: 0, color: COLORS.floorCentre },
        { offset: 1, color: COLORS.floorEdge },
      ],
    });
    const line = { width: 1, color: COLORS.floorLine };
    this.floor
      .clear()
      .circle(centre.x, centre.y, size * 0.65)
      .fill(gradient)
      .circle(centre.x, centre.y, track + HP_ARC_RADIUS + 10)
      .stroke(line)
      .circle(centre.x, centre.y, Math.max(0, track - HP_ARC_RADIUS - 10))
      .stroke(line)
      .circle(centre.x, centre.y, track * 0.32)
      .stroke(line);
  }

  /** Runs every frame. GSAP moves the values; this hands them to the seats. */
  private paint(): void {
    const state = this.state;
    if (!state) return;

    const display = this.display;
    for (const player of state.players) {
      const seat = this.seats.get(player.index);
      if (!seat) continue;

      // During a replay the seat shows where the round has got to, not where
      // it ended up. `shown` is null the rest of the time.
      const shown = display?.get(player.index) ?? null;
      const alive = shown?.alive ?? player.alive;
      seat.update({
        hp: shown?.hp ?? player.hp,
        maxHp: state.rules.startingHp || 100,
        alive,
        dying: shown?.dying ?? false,
        you: player.index === this.you,
        // Mid-replay, the snapshot's phase text is for a round nobody has seen
        // finish yet.
        ...(display || !alive ? { status: '', statusColor: COLORS.muted } : statusOf(state, player.index)),
      });

      // Scale, fade and offset are tweened on the replay's timeline; both ends
      // of every tween meet the static values, so nothing jumps when the
      // replay hands back to the snapshot.
      seat.root.scale.set(shown?.scale ?? 1);
      seat.root.alpha = shown ? shown.fade * shown.veil : alive ? 1 : DEAD_FADE;
      seat.root.position.set(seat.home.x + (shown?.dx ?? 0), seat.home.y + (shown?.dy ?? 0));
    }

    const { width, height } = this.app.screen;
    this.storm.update(stormRing(width, height, stallPressure(state)), this.replay?.stall.flare ?? 0);
    this.paintAim(display !== null);

    // The round on screen: the replay's while it plays, so the HUD never runs ahead.
    const round = display ? (this.replay?.round ?? state.round) : state.round;
    // What the penalty would be if this round passes without a hit too.
    const threat = stallDamageFor(state.rules, quietRounds(state.history) + 1);
    this.hudRound.text = String(round);
    this.hudStorm.text = threat > 0 ? `STALL  −${threat} HP IF NOBODY HITS` : 'STALL  NONE';
  }

  /** Puts your pick on the floor, or hides it when there is nothing to show. */
  private paintAim(replaying: boolean): void {
    const state = this.state;
    const aim = this.aim;
    const you = this.you === null ? undefined : this.seats.get(this.you);
    const target = aim ? this.seats.get(aim.target) : undefined;
    const live = state?.phase === MatchPhase.Commit || state?.phase === MatchPhase.Reveal;
    const ready = !!aim && !!you && live && !replaying && isAlive(state, this.you);
    const striking = ready && aim.action === Action.Strike && !!target && isAlive(state, aim.target);

    this.reticle.visible = striking;
    this.guard.visible = ready && aim.action === Action.Guard;
    this.veil.visible = ready && aim.action === Action.Charge;
    for (const marker of [this.reticle, this.guard, this.veil, this.aimLine]) {
      marker.alpha = this.aimSealed ? 0.45 : 1;
    }

    this.aimLine.clear();
    if (!you) return;
    this.guard.position.set(you.home.x, you.home.y);
    this.veil.position.set(you.home.x, you.home.y);
    if (striking && target) {
      this.reticle.position.set(target.home.x, target.home.y);
      this.aimLine
        .moveTo(you.home.x, you.home.y)
        .lineTo(target.home.x, target.home.y)
        .stroke({ width: 2, color: COLORS.aim, alpha: 0.6 });
    }
  }
}

function isPlaying(replay: Replay): boolean {
  const { timeline } = replay;
  return !timeline.paused() && timeline.progress() < 1;
}

/** How far the stall has come, from 0 (blows landed last round) to 1 (the penalty is biting). */
function stallPressure(state: PublicMatchState): number {
  return Math.min(1, quietRounds(state.history) / Math.max(1, state.rules.stallGraceRounds));
}

function isAlive(state: PublicMatchState | null, seat: number | null): boolean {
  return state?.players.find((player) => player.index === seat)?.alive ?? false;
}

/**
 * The line under a seat: whether it has moved yet this phase, and a loaded
 * Charge, which is public and the first thing a reader wants to know.
 */
function statusOf(state: PublicMatchState, seat: number): { status: string; statusColor: number } {
  const phase = phaseStatusOf(state, seat);
  if (!state.players.find((player) => player.index === seat)?.charged) return phase;
  return phase.status
    ? { status: `⚡ ${phase.status}`, statusColor: phase.statusColor }
    : { status: '⚡ charged', statusColor: COLORS.charged };
}

function phaseStatusOf(state: PublicMatchState, seat: number): { status: string; statusColor: number } {
  if (state.phase === MatchPhase.Commit) {
    return state.committed.includes(seat)
      ? { status: '✓ locked in', statusColor: COLORS.you }
      : { status: 'thinking…', statusColor: COLORS.muted };
  }
  if (state.phase === MatchPhase.Reveal) {
    return state.revealed.includes(seat)
      ? { status: 'revealed', statusColor: COLORS.parried }
      : { status: 'sealed', statusColor: COLORS.muted };
  }
  return { status: '', statusColor: COLORS.muted };
}
