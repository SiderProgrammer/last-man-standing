import { Application, Assets, Container, Graphics, Sprite, Text } from 'pixi.js';
import {
  MatchPhase,
  chainInfo,
  type AvatarEntry,
  type PublicMatchState,
  type RoundRecord,
} from '@lms/protocol';
import { loadAssets, type FxTextures } from '../assets/loader.js';
import { gsap } from '../motion.js';
import { choreograph } from './choreography.js';
import { Effects } from './effects.js';
import {
  AVATAR_RADIUS,
  AVATAR_SIZE,
  BADGE_Y,
  HP_ARC_RADIUS,
  SEAT_RADIUS,
  seatPosition,
  stormRing,
  type Point,
} from './layout.js';
import { buildReplay, DEAD_FADE, type Replay, type SeatDisplay } from './replay.js';
import { BADGE, COLORS, FX, LABEL, SUBLABEL, hpColor } from './theme.js';

/** Half a breath of the storm ring's idle pulse, in seconds. */
const STORM_BREATH = 2.2;

interface SeatView {
  root: Container;
  body: Graphics;
  ring: Graphics;
  name: Text;
  hp: Text;
  status: Text;
  /** Origin-chain badge: which chain this seat's stake came from. */
  chainBg: Graphics;
  chainText: Text;
  /** Chain currently drawn, so the badge is only re-rendered when it changes. */
  chainDrawn: number | null;
  /** Holds the avatar sprite, so z-order stays fixed while the texture loads. */
  avatarLayer: Container;
  avatarMask: Graphics;
  /** Image URL currently shown, so a repaint does not reload the texture. */
  avatarUrl: string | null;
  /** Where the seat sits on the ring, before any replay offset is applied. */
  home: Point;
}

/**
 * The Pixi view of a match.
 *
 * The arena renders only what the server published, so it can never leak a move
 * that has not been revealed: during the commit phase a seat shows *that* it
 * has committed, never what it committed to.
 *
 * While a round is being replayed, the arena deliberately shows *less* than it
 * knows. The post-round snapshot arrives a few milliseconds after the round
 * record, and painting it would snap every HP arc and grey out every casualty
 * before the replay could show how it happened. So for the length of the replay
 * each seat is drawn from the replay's `SeatDisplay` — values a GSAP timeline is
 * tweening — and the snapshot takes over again once the replay has finished.
 */
export class Arena {
  private readonly seats = new Map<number, SeatView>();
  private readonly avatars = new Map<number, AvatarEntry>();
  /** Everything that shakes together when a seat is eliminated. */
  private readonly world = new Container();
  private readonly seatLayer = new Container();
  private readonly stormLayer = new Graphics();
  private readonly effects: Effects;
  /** The storm ring's idle breathing, 0..1, tweened forever. */
  private readonly idle = { pulse: 0 };
  private state: PublicMatchState | null = null;
  private you: number | null = null;
  /** The most recent round replayed, whether or not it is still playing. */
  private replay: Replay | null = null;
  /** Whether the last frame was drawn from a playing replay. */
  private wasReplaying = false;

  private constructor(
    private readonly app: Application,
    textures: FxTextures,
  ) {
    this.effects = new Effects(app, textures, (seat) => this.homeOf(seat), this.world);
    this.world.addChild(this.stormLayer, this.seatLayer, this.effects.layer);
    app.stage.addChild(this.world);
    app.ticker.add(() => this.animate());
    app.renderer.on('resize', () => this.layout());
    gsap.to(this.idle, { pulse: 1, duration: STORM_BREATH, ease: 'sine.inOut', yoyo: true, repeat: -1 });
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
    }
    this.state = state;
    this.you = you;

    for (const player of state.players) {
      if (!this.seats.has(player.index)) this.seats.set(player.index, this.createSeat(player.index));
    }

    this.layout();
    this.paint();
  }

  /**
   * Applies the avatars the server resolved.
   *
   * Arrives separately from the match state and usually later, so a seat is
   * playable long before it has a face. Textures load in the background and a
   * seat that never gets one keeps its plain circle.
   */
  setAvatars(entries: readonly AvatarEntry[]): void {
    for (const entry of entries) this.avatars.set(entry.seat, entry);
    this.layout();
    this.paint();
    void this.loadAvatars();
  }

  /**
   * Replays a resolved round.
   *
   * Must be called *before* the post-round snapshot is rendered: the replay
   * starts from the HP the arena is currently showing, which at this moment is
   * still the state the round began with.
   */
  showRound(record: RoundRecord): void {
    const before = this.state?.players.map((player) => ({
      index: player.index,
      hp: player.hp,
      alive: player.alive,
    }));
    if (!before) return;

    const choreo = choreograph(record, before);
    const replay = buildReplay(record.round, choreo);
    this.effects.decorate(replay, choreo);
    // The previous round's timeline is left to finish on its own: anything of
    // it still in flight lands normally, it just no longer drives the seats.
    this.replay = replay;
    replay.timeline.play();
    this.paint();
  }

  /** Crowns the winner once the final round's replay has played out. */
  showWinner(seat: number): void {
    this.effects.showWinner(seat);
  }

  destroy(): void {
    this.replay?.timeline.kill();
    this.effects.clear();
    gsap.killTweensOf(this.idle);
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

  private homeOf(seat: number): Point | null {
    return this.seats.get(seat)?.home ?? null;
  }

  private createSeat(index: number): SeatView {
    const root = new Container();
    const body = new Graphics();
    const ring = new Graphics();
    const name = new Text({ text: `#${index}`, style: LABEL });
    const hp = new Text({ text: '', style: SUBLABEL });
    const status = new Text({ text: '', style: SUBLABEL });
    const chainBg = new Graphics();
    const chainText = new Text({ text: '', style: BADGE });
    const avatarLayer = new Container();
    const avatarMask = new Graphics().circle(0, 0, AVATAR_RADIUS).fill(0xffffff);
    avatarLayer.mask = avatarMask;

    name.anchor.set(0.5);
    hp.anchor.set(0.5);
    status.anchor.set(0.5);
    chainText.anchor.set(0.5);
    chainBg.y = BADGE_Y;
    chainText.y = BADGE_Y;

    // Explicit order, because the picture has to land between the circle and
    // the labels rather than on top of either.
    root.addChild(ring, body, avatarLayer, avatarMask, name, hp, status, chainBg, chainText);
    this.seatLayer.addChild(root);
    return {
      root,
      body,
      ring,
      name,
      hp,
      status,
      chainBg,
      chainText,
      chainDrawn: null,
      avatarLayer,
      avatarMask,
      avatarUrl: null,
      home: { x: 0, y: 0 },
    };
  }

  /**
   * Loads each seat's picture and drops it into the circle.
   *
   * Every failure is silent and local to one seat: these are third-party URLs
   * behind a public IPFS gateway, so a 404, a CORS refusal or a gateway that
   * simply never answers is an ordinary outcome, not an error worth showing a
   * player mid-match.
   */
  private async loadAvatars(): Promise<void> {
    await Promise.all(
      [...this.avatars.values()].map(async (entry) => {
        const view = this.seats.get(entry.seat);
        if (!view || !entry.image || view.avatarUrl === entry.image) return;

        try {
          const texture = await Assets.load(entry.image);
          // The view may have been torn down while the gateway was thinking.
          if (!this.seats.has(entry.seat)) return;

          const sprite = new Sprite(texture);
          sprite.anchor.set(0.5);
          sprite.width = AVATAR_SIZE;
          sprite.height = AVATAR_SIZE;
          view.avatarLayer.removeChildren();
          view.avatarLayer.addChild(sprite);
          view.avatarUrl = entry.image;
          this.paint();
        } catch {
          // Keep the plain circle; the seat is still fully playable.
        }
      }),
    );
  }

  /**
   * Draws the origin-chain pill above a seat.
   *
   * The width follows the measured text rather than a fixed box, because an
   * unknown chain falls back to its numeric id and those are much wider than a
   * ticker. Redrawn only when the chain changes: a seat's origin is fixed for
   * the match, and this runs for every seat on every state push.
   */
  private paintChainBadge(view: SeatView, chainId: number): void {
    if (view.chainDrawn === chainId) return;
    view.chainDrawn = chainId;

    const chain = chainInfo(chainId);
    view.chainText.text = chain.short;
    view.chainText.style.fill = chain.color;

    const width = view.chainText.width + 14;
    view.chainBg
      .clear()
      .roundRect(-width / 2, -9, width, 18, 9)
      .fill({ color: chain.color, alpha: 0.16 })
      .stroke({ width: 1, color: chain.color, alpha: 0.75 });
  }

  private layout(): void {
    const state = this.state;
    if (!state) return;

    const { width, height } = this.app.screen;
    // Avatars push each seat's labels below its circle, so the ring has to sit
    // further in or the bottom seats clip against the arena edge.
    const hasAvatars = this.avatars.size > 0;
    const count = state.players.length;

    state.players.forEach((player, position) => {
      const view = this.seats.get(player.index);
      if (!view) return;
      view.home = seatPosition(position, count, width, height, hasAvatars);
      view.root.position.set(view.home.x, view.home.y);
    });
  }

  private paint(): void {
    const state = this.state;
    if (!state) return;

    const committed = new Set(state.committed);
    const revealed = new Set(state.revealed);

    const display = this.display;
    for (const player of state.players) {
      const view = this.seats.get(player.index);
      if (!view) continue;

      // During a replay the seat shows where the round has got to, not where
      // it ended up. `shown` is null the rest of the time.
      const shown = display?.get(player.index) ?? null;
      const hp = shown?.hp ?? player.hp;
      const alive = shown?.alive ?? player.alive;
      const dying = shown?.dying ?? false;

      const isYou = player.index === this.you;
      const fraction = Math.max(0, Math.min(1, hp / 100));
      const arcColor = hpColor(fraction);

      view.body
        .clear()
        .circle(0, 0, SEAT_RADIUS)
        .fill(alive ? COLORS.seat : COLORS.seatDead)
        .stroke({
          width: isYou ? 3 : 1.5,
          // A dying seat's outline heats up as it goes.
          color: dying ? FX.kill : isYou ? COLORS.you : COLORS.outline,
        });

      // An eliminated seat greys out; the whole container is already faded, and
      // dimming the picture keeps a bright avatar from reading as alive.
      const wearing = view.avatarUrl !== null;
      view.avatarLayer.visible = wearing;
      view.avatarLayer.alpha = alive ? 1 : 0.5;

      // A seat wearing an avatar gives the circle over to the picture and moves
      // its labels below it. Keeping them inside would mean covering the avatar
      // with a scrim to stay readable, which defeats the point of having one.
      view.name.y = wearing ? 44 : -8;
      view.hp.y = wearing ? 58 : 8;
      // Clear of the HP arc, so the label never sits on it.
      view.status.y = wearing ? 74 : 54;

      view.ring.clear();
      if (alive && fraction > 0) {
        view.ring
          .arc(0, 0, HP_ARC_RADIUS, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction)
          .stroke({ width: 4, color: arcColor, cap: 'round' });
      }

      this.paintChainBadge(view, player.chainId);
      view.name.text = isYou ? `#${player.index} (you)` : `#${player.index}`;
      view.name.style.fill = alive ? COLORS.text : COLORS.muted;
      view.hp.text = alive ? `${Math.round(hp)} hp` : 'out';

      // Scale, fade and offset are tweened on the replay's timeline; both ends
      // of every tween meet the static values, so nothing jumps when the
      // replay hands back to the snapshot.
      view.root.scale.set(shown?.scale ?? 1);
      view.root.alpha = shown ? shown.fade * shown.veil : alive ? 1 : DEAD_FADE;
      view.root.position.set(view.home.x + (shown?.dx ?? 0), view.home.y + (shown?.dy ?? 0));

      if (display) {
        // Mid-replay, the snapshot's phase text is for a round nobody has seen
        // finish yet.
        view.status.text = '';
      } else if (state.phase === MatchPhase.Commit) {
        view.status.text = committed.has(player.index) ? 'locked in' : 'thinking…';
      } else if (state.phase === MatchPhase.Reveal) {
        view.status.text = revealed.has(player.index) ? 'revealed' : 'sealed';
      } else {
        view.status.text = '';
      }
      view.status.style.fill = COLORS.muted;
    }

    this.paintStorm();
  }

  private paintStorm(): void {
    const state = this.state;
    if (!state) return;

    const { width, height } = this.app.screen;
    const ring = stormRing(width, height, state.round);
    const flare = this.replay?.storm.flare ?? 0;
    this.stormLayer
      .clear()
      .circle(ring.centre.x, ring.centre.y, ring.radius)
      .stroke({
        width: 2 + ring.intensity * 6 + flare * 6,
        color: flare > 0 ? FX.storm : COLORS.storm,
        alpha: Math.min(1, 0.35 + 0.4 * this.idle.pulse + flare * 0.5),
      });
  }

  /**
   * Called every frame. GSAP moves the values; this only draws them — every
   * frame while a replay plays, once more as it hands back to the snapshot,
   * and otherwise just the storm ring's idle breathing.
   */
  private animate(): void {
    const replaying = this.replay !== null && isPlaying(this.replay);
    if (replaying || replaying !== this.wasReplaying) this.paint();
    else this.paintStorm();
    this.wasReplaying = replaying;
  }
}

function isPlaying(replay: Replay): boolean {
  const { timeline } = replay;
  return !timeline.paused() && timeline.progress() < 1;
}
