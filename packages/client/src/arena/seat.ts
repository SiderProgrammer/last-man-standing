import { Assets, Circle, Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { chainInfo } from '@lms/protocol';
import { gsap } from '../motion.js';
import { AVATAR_RADIUS, AVATAR_SIZE, BADGE_Y, HP_ARC_RADIUS, SEAT_RADIUS, type Point } from './layout.js';
import { TextureLeases } from './textures.js';
import { BADGE, COLORS, FX, HP_LABEL, LABEL, SUBLABEL, hpColor } from './theme.js';

/** Every seat's face, shared by URL and unloaded once no seat wears it. */
const faces = new TextureLeases<Texture>(
  (url) => Assets.load<Texture>(url),
  (url) => Assets.unload(url),
);

/** Nameplate and status line, below the seat's HP arc. */
const PLATE_Y = 56;
const STATUS_Y = 77;
/** Radius of your own seat's halo, and of the ring on a seat you hover. */
export const HALO_RADIUS = 47;
/** How long the lost-HP ghost arc lingers before it drains. */
const GHOST_HOLD = 0.4;
/** Seconds for a damage flash to fade out. */
const FLASH_FADE = 0.28;
const TOP = -Math.PI / 2;

/** Everything a seat needs to know to draw itself for one frame. */
export interface SeatLook {
  hp: number;
  maxHp: number;
  alive: boolean;
  dying: boolean;
  you: boolean;
  status: string;
  statusColor: number;
}

/**
 * One seat on the ring: its face, HP arc, nameplate and chain badge.
 *
 * Shapes that never change are drawn once and animated by GSAP — the halo
 * turns, a hit flashes and punches. Only the HP arc is redrawn every frame,
 * because the replay tweens HP continuously.
 */
export class SeatToken {
  readonly root = new Container();
  /** Where the seat sits on the ring, before any replay offset is applied. */
  home: Point = { x: 0, y: 0 };

  private readonly token = new Container();
  private readonly aura: Sprite;
  private readonly ring = new Graphics();
  private readonly halo = dashedRing(HALO_RADIUS, 14, 0.55).stroke({
    width: 2,
    color: COLORS.you,
    alpha: 0.75,
  });
  private readonly hover = new Graphics()
    .circle(0, 0, HALO_RADIUS - 2)
    .stroke({ width: 2, color: COLORS.aim, alpha: 0.55 });
  private readonly disc = new Graphics();
  private readonly avatar = new Container();
  private readonly flash = new Graphics().circle(0, 0, SEAT_RADIUS).fill(0xffffff);
  private readonly cross = new Graphics()
    .moveTo(-16, -16)
    .lineTo(16, 16)
    .moveTo(16, -16)
    .lineTo(-16, 16)
    .stroke({ width: 5, color: COLORS.attack, alpha: 0.9, cap: 'round' });
  private readonly plate = new Graphics();
  private readonly name: Text;
  private readonly hp = new Text({ text: '', style: HP_LABEL });
  private readonly status = new Text({ text: '', style: SUBLABEL });

  private avatarUrl: string | null = null;
  /** True once an NFT avatar has replaced the generated one. */
  private avatarOwned = false;
  /** HP drawn last frame, to notice the moment a blow lands. */
  private shownHp: number | null = null;
  /** The lost-HP arc that trails behind the real one; GSAP drains it. */
  private ghost = 0;
  /** Style last applied, so labels and the disc are only restyled on change. */
  private styled = '';

  constructor(
    private readonly index: number,
    chainId: number,
    glow: Texture,
    private readonly reduced: boolean,
    onTap: () => void,
  ) {
    this.name = new Text({ text: `#${index}`, style: LABEL });
    this.aura = new Sprite(glow);
    this.aura.anchor.set(0.5);
    this.aura.blendMode = 'add';
    this.aura.width = this.aura.height = 150;
    this.flash.alpha = 0;
    this.flash.blendMode = 'add';
    this.hover.visible = false;
    this.name.anchor.set(0, 0.5);
    this.hp.anchor.set(0, 0.5);
    this.status.anchor.set(0.5);
    this.name.y = this.hp.y = PLATE_Y;
    this.status.y = STATUS_Y;

    const mask = new Graphics().circle(0, 0, AVATAR_RADIUS).fill(0xffffff);
    this.avatar.mask = mask;
    this.token.addChild(
      this.aura,
      this.ring,
      this.halo,
      this.hover,
      this.disc,
      this.avatar,
      mask,
      this.flash,
      this.cross,
    );
    this.root.addChild(this.token, this.plate, this.name, this.hp, this.status, chainBadge(chainId));

    // Clicking a seat targets it; the hit area covers the token, not the labels.
    this.root.eventMode = 'static';
    this.root.hitArea = new Circle(0, 0, HP_ARC_RADIUS + 6);
    this.root.on('pointertap', onTap);
    this.root.on('pointerover', () => (this.hover.visible = this.root.cursor === 'pointer'));
    this.root.on('pointerout', () => (this.hover.visible = false));

    if (!reduced) gsap.to(this.halo, { rotation: Math.PI * 2, duration: 10, repeat: -1, ease: 'none' });
  }

  /** Whether the player can click this seat to target it right now. */
  set pickable(value: boolean) {
    this.root.cursor = value ? 'pointer' : 'default';
    if (!value) this.hover.visible = false;
  }

  update(look: SeatLook): void {
    this.trackHp(look.hp);
    this.drawRing(look);

    const hpLabel = look.alive ? `${Math.round(look.hp)}` : 'OUT';
    const style = `${look.alive}|${look.you}|${look.dying}|${hpLabel}|${look.status}|${look.statusColor}`;
    if (style !== this.styled) {
      this.styled = style;
      this.restyle(look, hpLabel);
    }
  }

  /**
   * Loads a picture into the seat's circle. Failures are silent: NFT images
   * sit behind a public IPFS gateway, where a 404 or a gateway that never
   * answers is ordinary, so the seat just keeps the face it already had.
   */
  async wear(url: string, owned: boolean): Promise<void> {
    if (this.avatarUrl === url || (this.avatarOwned && !owned)) return;
    let texture: Texture;
    try {
      texture = await faces.acquire(url);
    } catch {
      // Keep the current face; the seat is still fully playable.
      faces.release(url);
      return;
    }
    // Destroyed while it loaded, or an NFT arrived while the generated face
    // was still loading: the lease goes straight back.
    if (this.root.destroyed || (this.avatarOwned && !owned) || this.avatarUrl === url) {
      faces.release(url);
      return;
    }
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    sprite.width = sprite.height = AVATAR_SIZE;
    for (const old of this.avatar.removeChildren()) old.destroy();
    this.avatar.addChild(sprite);
    if (this.avatarUrl) faces.release(this.avatarUrl);
    this.avatarUrl = url;
    this.avatarOwned = owned;
  }

  /** Removes the seat and hands back its face, which is unloaded if no other seat wears it. */
  destroy(): void {
    gsap.killTweensOf([this, this.halo, this.flash, this.token.scale]);
    this.root.destroy({ children: true });
    if (this.avatarUrl) faces.release(this.avatarUrl);
    this.avatarUrl = null;
  }

  /** Flashes and punches the token the moment HP drops, and lets the ghost arc trail. */
  private trackHp(hp: number): void {
    if (this.shownHp !== null && hp < this.shownHp - 0.01) {
      if (!gsap.isTweening(this.flash)) {
        gsap.fromTo(this.flash, { alpha: 0.85 }, { alpha: 0, duration: FLASH_FADE });
        if (!this.reduced) {
          gsap.fromTo(
            this.token.scale,
            { x: 1.12, y: 1.12 },
            { x: 1, y: 1, duration: FLASH_FADE, ease: 'back.out(3)' },
          );
        }
      }
      // Restarted on every frame of a drain, so it waits until the HP settles.
      gsap.to(this, { ghost: hp, delay: GHOST_HOLD, duration: 0.5, ease: 'power2.in', overwrite: true });
    } else if (hp > this.ghost) {
      this.ghost = hp;
    }
    this.shownHp = hp;
  }

  private drawRing(look: SeatLook): void {
    const ring = this.ring.clear();
    if (!look.alive) return;
    const fraction = gsap.utils.clamp(0, 1, look.hp / look.maxHp);
    const ghost = gsap.utils.clamp(0, 1, this.ghost / look.maxHp);

    ring.circle(0, 0, HP_ARC_RADIUS).stroke({ width: 5, color: 0x000000, alpha: 0.45 });
    if (ghost > fraction) hpArc(ring, fraction, ghost).stroke({ width: 5, color: 0xffffff, alpha: 0.75 });
    if (fraction > 0) {
      hpArc(ring, 0, fraction).stroke({
        width: 5,
        color: look.dying ? FX.kill : hpColor(fraction),
        cap: 'round',
      });
    }
  }

  private restyle(look: SeatLook, hpLabel: string): void {
    const { alive, you } = look;
    const fraction = look.hp / look.maxHp;

    this.disc
      .clear()
      .circle(0, 0, SEAT_RADIUS)
      .fill(alive ? COLORS.seat : COLORS.seatDead)
      .stroke({ width: you ? 3 : 1.5, color: look.dying ? FX.kill : you ? COLORS.you : COLORS.outline });
    this.avatar.alpha = alive ? 1 : 0.4;
    this.cross.visible = !alive;
    this.halo.visible = you && alive;
    this.aura.visible = alive;
    this.aura.tint = you ? COLORS.you : hpColor(fraction);
    this.aura.alpha = you ? 0.38 : 0.14;

    this.name.text = you ? `YOU #${this.index}` : `#${this.index}`;
    this.name.style.fill = you && alive ? COLORS.background : alive ? COLORS.text : COLORS.muted;
    this.hp.text = hpLabel;
    this.hp.style.fill = !alive ? COLORS.attack : you ? COLORS.background : hpColor(fraction);
    this.status.text = look.status;
    this.status.style.fill = look.statusColor;

    // The plate fits its two labels, with the HP right after the name.
    const width = this.name.width + this.hp.width + 24;
    this.name.x = -width / 2 + 9;
    this.hp.x = this.name.x + this.name.width + 6;
    this.plate.clear().roundRect(-width / 2, PLATE_Y - 10, width, 20, 10);
    if (you && alive) this.plate.fill({ color: COLORS.you, alpha: 0.95 });
    else this.plate.fill({ color: 0x0b0f17, alpha: 0.85 }).stroke({ width: 1, color: COLORS.outline });
  }
}

/** A stretch of the HP circle, as a fraction of it from the top, clockwise; the caller strokes. */
function hpArc(graphics: Graphics, from: number, to: number): Graphics {
  const start = TOP + Math.PI * 2 * from;
  return graphics
    .moveTo(Math.cos(start) * HP_ARC_RADIUS, Math.sin(start) * HP_ARC_RADIUS)
    .arc(0, 0, HP_ARC_RADIUS, start, TOP + Math.PI * 2 * to);
}

/** The origin-chain pill above a seat, sized to its label. */
function chainBadge(chainId: number): Container {
  const chain = chainInfo(chainId);
  const label = new Text({ text: chain.short, style: { ...BADGE, fill: chain.color } });
  label.anchor.set(0.5);
  const width = label.width + 14;
  const pill = new Graphics()
    .roundRect(-width / 2, -9, width, 18, 9)
    .fill({ color: chain.color, alpha: 0.16 })
    .stroke({ width: 1, color: chain.color, alpha: 0.75 });
  const badge = new Container();
  badge.addChild(pill, label);
  badge.y = BADGE_Y;
  return badge;
}

/**
 * A ring of evenly spaced arcs around the origin, unstroked. Pixi has no
 * dashed stroke, so this is the one place the dashes are laid out; GSAP turns
 * the result.
 */
export function dashedRing(
  radius: number,
  dashes: number,
  fill: number,
  graphics = new Graphics(),
): Graphics {
  const step = (Math.PI * 2) / dashes;
  for (let dash = 0; dash < dashes; dash += 1) {
    const start = dash * step;
    graphics
      .moveTo(Math.cos(start) * radius, Math.sin(start) * radius)
      .arc(0, 0, radius, start, start + step * fill);
  }
  return graphics;
}
