import { dom } from '../context.js';
import { gsap } from '../motion.js';

/**
 * The boot screen, shown while the arena's assets load. It covers the page
 * rather than blocking it: the socket connects and the lobby renders behind
 * it, so nothing waits on the textures except the view.
 */

export function showLoadProgress(fraction: number): void {
  gsap.to(dom.loaderBar, { scaleX: fraction, duration: 0.25, ease: 'power1.out', overwrite: true });
  dom.loaderLabel.textContent = `${Math.round(fraction * 100)}%`;
}

/** Lets the bar finish filling, fades the screen out, and removes it. */
export function hideLoader(): Promise<void> {
  return new Promise((resolve) => {
    gsap.to(dom.loader, {
      autoAlpha: 0,
      duration: 0.35,
      delay: 0.2,
      ease: 'power1.out',
      onComplete: () => {
        dom.loader.remove();
        resolve();
      },
    });
  });
}
