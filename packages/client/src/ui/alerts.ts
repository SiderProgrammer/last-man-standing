import { readRaw, writeRaw } from '../io/storage.js';
import { alertInBackground } from './chrome.js';

/**
 * What reaches a player who is looking at another tab: the title (see
 * `alertInBackground`), a browser notification for the moments that need
 * them back — a table ready, a match starting — and, if they turned it on,
 * a soft sound when a round opens and when ten seconds are left.
 *
 * Both are opt-in: a notification needs the browser's permission, asked
 * only from a click, and sound is off until the player ticks it.
 */

const SOUND_KEY = 'lms:sound-cues';

export function soundOn(): boolean {
  return readRaw(SOUND_KEY) === '1';
}

export function setSound(on: boolean): void {
  writeRaw(SOUND_KEY, on ? '1' : '0');
  if (on) cue('round');
}

/** Whether the browser lets this page notify, has not been asked yet, or cannot at all. */
export function notifyState(): 'on' | 'ask' | 'blocked' | 'unsupported' {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission === 'granted') return 'on';
  return Notification.permission === 'denied' ? 'blocked' : 'ask';
}

/** Asks the browser for permission to notify. Only ever from a click. */
export async function askToNotify(): Promise<void> {
  if (notifyState() === 'ask') await Notification.requestPermission();
}

/**
 * Calls the player back while the tab is hidden: the title always, a
 * notification when they allowed it. Nothing while they are looking.
 */
export function callBack(title: string, body: string): void {
  if (!document.hidden) return;
  alertInBackground(title);
  if (notifyState() !== 'on') return;
  try {
    const note = new Notification(title, { body, tag: 'lms' });
    note.onclick = () => {
      window.focus();
      note.close();
    };
  } catch {
    // Some browsers only notify from a service worker: the title still shows it.
  }
}

let audio: AudioContext | null = null;

/**
 * A short, soft tone: one note when a round opens, two quick ones at ten
 * seconds. Made in the browser, so there is no sound file to fetch.
 */
export function cue(kind: 'round' | 'warning'): void {
  if (!soundOn()) return;
  try {
    audio ??= new AudioContext();
    const notes = kind === 'round' ? [660] : [880, 880];
    notes.forEach((frequency, i) => {
      const start = audio!.currentTime + i * 0.16;
      const oscillator = audio!.createOscillator();
      const gain = audio!.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      oscillator.connect(gain).connect(audio!.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.15);
    });
  } catch {
    // No audio: the timer still pulses.
  }
}
