import {
  Application,
  Assets,
  Container,
  Graphics,
  Sprite,
  Text,
  type TextStyleOptions,
} from 'pixi.js';
import {
  AttackOutcome,
  MatchPhase,
  chainInfo,
  type AvatarEntry,
  type PublicMatchState,
  type RoundRecord,
} from '@lms/protocol';

const COLORS = {
  seat: 0x1b2331,
  seatDead: 0x11151d,
  outline: 0x2b3547,
  you: 0x52d1a4,
  hp: 0x52d1a4,
  hpLow: 0xe6b455,
  hpCritical: 0xe0575b,
  text: 0xdbe3f0,
  muted: 0x8794ab,
  attack: 0xe0575b,
  parried: 0x6fa8f5,
  missed: 0x5a6579,
  storm: 0x3a2d4a,
} as const;

const LABEL: TextStyleOptions = { fill: COLORS.text, fontFamily: 'Segoe UI, sans-serif', fontSize: 14 };
const SUBLABEL: TextStyleOptions = { fill: COLORS.muted, fontFamily: 'Segoe UI, sans-serif', fontSize: 11 };
const BADGE: TextStyleOptions = {
  fill: COLORS.text,
  fontFamily: 'Segoe UI, sans-serif',
  fontSize: 10,
  letterSpacing: 0.6,
};

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
  private readonly bolts: Bolt[] = [];
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
      background: 0x070a10,
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
    const avatarMask = new Graphics().circle(0, 0, 28).fill(0xffffff);
    avatarLayer.mask = avatarMask;

    name.anchor.set(0.5);
    hp.anchor.set(0.5);
    status.anchor.set(0.5);
    chainText.anchor.set(0.5);
    // Above the circle (radius 30) and clear of the HP arc (radius 38).
    chainBg.y = -52;
    chainText.y = -52;

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
          sprite.width = 56;
          sprite.height = 56;
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
    // Avatars push each seat's labels below its circle, so the ring of seats
    // has to sit further in or the bottom ones clip against the arena edge.
    const margin = this.avatars.size > 0 ? 92 : 70;
    const radius = Math.min(width, height) / 2 - margin;
    const centreX = width / 2;
    const centreY = height / 2;
    const count = state.players.length || 1;

    state.players.forEach((player, position) => {
      const view = this.seats.get(player.index);
      if (!view) return;
      // Start at the top and go clockwise so seat #0 is where players expect it.
      const angle = (position / count) * Math.PI * 2 - Math.PI / 2;
      view.root.x = centreX + Math.cos(angle) * radius;
      view.root.y = centreY + Math.sin(angle) * radius;
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
      const hpColor =
        fraction > 0.5 ? COLORS.hp : fraction > 0.25 ? COLORS.hpLow : COLORS.hpCritical;

      view.body
        .clear()
        .circle(0, 0, 30)
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
      // Clear of the HP ring at radius 38, so the label never sits on the arc.
      view.status.y = wearing ? 74 : 54;

      view.ring.clear();
      if (player.alive && fraction > 0) {
        view.ring
          .arc(0, 0, 38, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction)
          .stroke({ width: 4, color: hpColor, cap: 'round' });
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
    const radius = Math.min(width, height) / 2 - 20;
    // The ring tightens as the storm damage ramps with the round number.
    const intensity = Math.min(1, state.round / 12);
    this.stormLayer
      .clear()
      .circle(width / 2, height / 2, radius - intensity * 30)
      .stroke({ width: 2 + intensity * 6, color: COLORS.storm, alpha: 0.35 + 0.4 * this.pulse });
  }

  private flagStatus(seat: number, text: string): void {
    const view = this.seats.get(seat);
    if (view) view.status.text = text;
  }

  private animate(deltaSeconds: number): void {
    this.pulse = (Math.sin(performance.now() / 700) + 1) / 2;
    this.paintStorm();

    if (this.bolts.length === 0) {
      this.boltLayer.clear();
      return;
    }

    this.boltLayer.clear();
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

    for (let index = this.bolts.length - 1; index >= 0; --index) {
      const bolt = this.bolts[index];
      if (bolt && bolt.life <= 0) this.bolts.splice(index, 1);
    }
  }
}
