import { Color, Container, FillGradient, Graphics } from 'pixi.js';
import { gsap } from '../motion.js';
import type { StormRing } from './layout.js';
import { dashedRing } from './seat.js';
import { COLORS, FX } from './theme.js';

/** Where the fog starts, as a fraction of the fog disc's radius. */
const FOG_EDGE = 0.4;

/** The storm's colours as CSS strings, so GSAP can blend between them. */
const FOG_CALM = new Color(COLORS.stormFog).toHex();
const FOG_FLARE = new Color(FX.storm).toHex();
const WALL_CALM = new Color(COLORS.stormEdge).toHex();
const WALL_FLARE = '#ffffff';

/**
 * The closing storm: fog pressing in from the walls, a glowing wall, and two
 * bands of arcs swirling along it in opposite directions.
 *
 * Everything is drawn white once per radius — the ring only moves with the
 * round or a resize — and tinted per frame. GSAP turns the bands and makes
 * the glow breathe.
 */
export class Storm {
  readonly layer = new Container();
  private readonly fog = new Graphics();
  private readonly glow = new Graphics();
  private readonly wall = new Graphics();
  private readonly bands = [new Graphics(), new Graphics()] as const;
  private radius = 0;

  constructor(reduced: boolean) {
    this.layer.addChild(this.fog, this.glow, this.wall, ...this.bands);
    gsap.fromTo(
      this.glow,
      { alpha: 0.5 },
      { alpha: 1, duration: 2.2, ease: 'sine.inOut', yoyo: true, repeat: -1 },
    );
    if (!reduced) {
      gsap.to(this.bands[0], { rotation: Math.PI * 2, duration: 40, repeat: -1, ease: 'none' });
      gsap.to(this.bands[1], { rotation: -Math.PI * 2, duration: 55, repeat: -1, ease: 'none' });
    }
  }

  /** `flare` is the replay's storm beat, 0..1. */
  update(ring: StormRing, flare: number): void {
    if (ring.radius !== this.radius) this.redraw(ring);

    const wallTint = gsap.utils.interpolate(WALL_CALM, WALL_FLARE, flare * 0.5);
    this.fog.tint = gsap.utils.interpolate(FOG_CALM, FOG_FLARE, flare);
    this.fog.alpha = Math.min(1, 0.35 + 0.5 * ring.intensity + flare * 0.4);
    this.wall.tint = wallTint;
    this.wall.alpha = Math.min(1, 0.6 + flare * 0.4);
    for (const band of this.bands) {
      band.tint = wallTint;
      band.alpha = Math.min(1, 0.25 + 0.4 * ring.intensity + flare * 0.3);
    }
  }

  destroy(): void {
    gsap.killTweensOf([this.glow, ...this.bands]);
  }

  private redraw({ centre, radius }: StormRing): void {
    this.radius = radius;
    // Clear at the eye of the storm, thickening toward the walls.
    this.fog
      .clear()
      .circle(centre.x, centre.y, radius / FOG_EDGE)
      .fill(
        new FillGradient({
          type: 'radial',
          colorStops: [
            { offset: FOG_EDGE, color: 'rgba(255, 255, 255, 0)' },
            { offset: FOG_EDGE + 0.03, color: 'rgba(255, 255, 255, 0.22)' },
            { offset: 1, color: 'rgba(255, 255, 255, 0.62)' },
          ],
        }),
      );
    this.glow
      .clear()
      .circle(centre.x, centre.y, radius)
      .stroke({ width: 26, color: COLORS.stormFog, alpha: 0.18 });
    this.wall.clear().circle(centre.x, centre.y, radius).stroke({ width: 3, color: 0xffffff });

    const [inner, outer] = this.bands;
    dashedRing(radius - 6, 20, 0.35, inner.clear()).stroke({ width: 2, color: 0xffffff });
    dashedRing(radius + 8, 26, 0.25, outer.clear()).stroke({ width: 1.5, color: 0xffffff });
    inner.position.set(centre.x, centre.y);
    outer.position.set(centre.x, centre.y);
  }
}
