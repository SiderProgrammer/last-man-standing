import { Application, Assets, Container, Graphics, Sprite, Text } from 'pixi.js';
import {
  AttackOutcome,
  MatchPhase,
  chainInfo,
  type AvatarEntry,
  type PublicMatchState,
  type RoundRecord,
} from '@lms/protocol';
import {
  AVATAR_RADIUS,
  AVATAR_SIZE,
  BADGE_Y,
  HP_ARC_RADIUS,
  SEAT_RADIUS,
  seatPosition,
  stormRing,
} from './layout.js';
import { BADGE, COLORS, LABEL, SUBLABEL, hpColor } from './theme.js';

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
}

interface Bolt {
  from: number;
  to: number;
  outcome: string;
  /** Seconds of life remaining; the bolt fades as it drains. */
  life: number;
}

/**
 * The Pixi view of a match.
 *
 * The arena renders only what the server published, so it can never leak a move
 * that has not been revealed: during the commit phase a seat shows *that* it
 * has committed, never what it committed to.
 */
export class Arena {
  private readonly seats = new Map<number, SeatView>();
  private readonly avatars = new Map<number, AvatarEntry>();
  private bolts: Bolt[] = [];
  private readonly seatLayer = new Container();
  private readonly boltLayer = new Graphics();
  private readonly stormLayer = new Graphics();
  private state: PublicMatchState | null = null;
  private you: number | null = null;
  private pulse = 0;

  private constructor(private readonly app: Application) {
    app.stage.addChild(this.stormLayer, this.boltLayer, this.seatLayer);
    app.ticker.add((ticker) => this.animate(ticker.deltaMS / 1000));
    app.renderer.on('resize', () => this.layout());
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
    return new Arena(app);
  }

  render(state: PublicMatchState, you: number | null): void {
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

  /** Replays a resolved round as bolts between the seats involved. */
  showRound(record: RoundRecord): void {
    this.bolts.length = 0;
    for (const attack of record.attacks) {
      if (attack.outcome === AttackOutcome.Void) continue;
      this.bolts.push({ from: attack.attacker, to: attack.target, outcome: attack.outcome, life: 2.5 });
    }
    for (const move of record.moves) {
      if (move.revealed || !this.seats.has(move.index)) continue;
      this.flagStatus(move.index, 'no show');
    }
  }

  destroy(): void {
    this.app.destroy(true, { children: true });
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
      const { x, y } = seatPosition(position, count, width, height, hasAvatars);
      view.root.x = x;
      view.root.y = y;
    });
  }

  private paint(): void {
    const state = this.state;
    if (!state) return;

    const committed = new Set(state.committed);
    const revealed = new Set(state.revealed);

    for (const player of state.players) {
      const view = this.seats.get(player.index);
      if (!view) continue;

      const isYou = player.index === this.you;
      const fraction = Math.max(0, Math.min(1, player.hp / 100));
      const arcColor = hpColor(fraction);

      view.body
        .clear()
        .circle(0, 0, SEAT_RADIUS)
        .fill(player.alive ? COLORS.seat : COLORS.seatDead)
        .stroke({ width: isYou ? 3 : 1.5, color: isYou ? COLORS.you : COLORS.outline });

      // An eliminated seat greys out; the whole container is already faded, and
      // dimming the picture keeps a bright avatar from reading as alive.
      const wearing = view.avatarUrl !== null;
      view.avatarLayer.visible = wearing;
      view.avatarLayer.alpha = player.alive ? 1 : 0.5;

      // A seat wearing an avatar gives the circle over to the picture and moves
      // its labels below it. Keeping them inside would mean covering the avatar
      // with a scrim to stay readable, which defeats the point of having one.
      view.name.y = wearing ? 44 : -8;
      view.hp.y = wearing ? 58 : 8;
      // Clear of the HP arc, so the label never sits on it.
      view.status.y = wearing ? 74 : 54;

      view.ring.clear();
      if (player.alive && fraction > 0) {
        view.ring
          .arc(0, 0, HP_ARC_RADIUS, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction)
          .stroke({ width: 4, color: arcColor, cap: 'round' });
      }

      this.paintChainBadge(view, player.chainId);
      view.name.text = isYou ? `#${player.index} (you)` : `#${player.index}`;
      view.name.style.fill = player.alive ? COLORS.text : COLORS.muted;
      view.hp.text = player.alive ? `${player.hp} hp` : 'out';
      view.root.alpha = player.alive ? 1 : 0.4;

      if (state.phase === MatchPhase.Commit) {
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
    this.stormLayer
      .clear()
      .circle(ring.centre.x, ring.centre.y, ring.radius)
      .stroke({
        width: 2 + ring.intensity * 6,
        color: COLORS.storm,
        alpha: 0.35 + 0.4 * this.pulse,
      });
  }

  private flagStatus(seat: number, text: string): void {
    const view = this.seats.get(seat);
    if (view) view.status.text = text;
  }

  private animate(deltaSeconds: number): void {
    this.pulse = (Math.sin(performance.now() / 700) + 1) / 2;
    this.paintStorm();

    this.boltLayer.clear();
    if (this.bolts.length === 0) return;

    for (const bolt of this.bolts) {
      bolt.life -= deltaSeconds;
      const from = this.seats.get(bolt.from)?.root;
      const to = this.seats.get(bolt.to)?.root;
      if (!from || !to || bolt.life <= 0) continue;

      const color =
        bolt.outcome === AttackOutcome.Hit
          ? COLORS.attack
          : bolt.outcome === AttackOutcome.Parried
            ? COLORS.parried
            : COLORS.missed;

      this.boltLayer
        .moveTo(from.x, from.y)
        .lineTo(to.x, to.y)
        .stroke({ width: 2.5, color, alpha: Math.min(1, bolt.life / 2.5) });
    }

    this.bolts = this.bolts.filter((bolt) => bolt.life > 0);
  }
}
