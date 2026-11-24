/**
 * The files that contain a dev burner key, by name.
 *
 * Vite writes a `VITE_` value into the bundle wherever the source reads it,
 * and all of them where it reads `import.meta.env` whole. A key that gets there
 * is published, so the production build fails on any match (`vite.config.ts`).
 * Matched without the `0x`, and in any case, so no spelling slips through.
 */
export function filesWithDevKeys(
  env: Record<string, string | undefined>,
  files: readonly { name: string; text: string }[],
): string[] {
  const keys = [env.VITE_DEV_KEY ?? '', ...(env.VITE_DEV_KEYS ?? '').split(',')]
    .map((key) => key.trim().toLowerCase().replace(/^0x/, ''))
    .filter(Boolean);
  return files.filter(({ text }) => {
    const lower = text.toLowerCase();
    return keys.some((key) => lower.includes(key));
  }).map(({ name }) => name);
}
