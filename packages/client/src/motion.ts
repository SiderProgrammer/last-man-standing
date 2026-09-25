import { gsap } from 'gsap';
import { MotionPathPlugin } from 'gsap/MotionPathPlugin';
import { Physics2DPlugin } from 'gsap/Physics2DPlugin';

/**
 * GSAP, configured once for the whole client. Import `gsap` from here rather
 * than from the package, so the plugins are registered before anything tweens.
 *
 * - `MotionPathPlugin` curves a projectile through its arc and turns it to face
 *   the way it is travelling.
 * - `Physics2DPlugin` throws debris and sparks with a velocity, an angle and
 *   gravity.
 */
gsap.registerPlugin(MotionPathPlugin, Physics2DPlugin);

/**
 * Real time, not smoothed. By default GSAP treats a long gap between frames as
 * lag and holds its clock back across it. Here that is wrong: the server's
 * replay hold runs on wall-clock time, and a replay that fell behind it would
 * spill into the next commit window.
 */
gsap.ticker.lagSmoothing(0);

export { gsap };
