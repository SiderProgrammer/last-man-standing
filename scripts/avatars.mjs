#!/usr/bin/env node
/**
 * `npm run avatars -- <command>` — makes the art and metadata `PlayerAvatars`
 * points at, ready to pin on IPFS. The art is DiceBear "Pixel Art" (by
 * DiceBear, CC0 1.0, so no credit is owed), seeded by token id: the same id
 * always draws the same picture, so a re-run produces the same bytes and the
 * same CID.
 *
 *   images [--count 100]                 writes dist/avatars/images/<id>.svg
 *   metadata <imagesCid> [--count 100]   writes dist/avatars/metadata/<id>, each naming
 *                                        ipfs://<imagesCid>/<id>.svg as its image
 *   check <baseUri> [--id 1]             fetches token <id>'s metadata and image through
 *                                        IPFS_GATEWAY, the way the server does
 *
 * The two folders are uploaded one after the other: the metadata has to name
 * the images' CID, so it cannot be written until the images are pinned. The
 * metadata files have no extension because `tokenURI` is `baseUri + id`.
 * `--count` defaults to AVATAR_MAX_SUPPLY, then 100; it must cover the
 * collection's `maxSupply`, or the last mints point at files that do not exist.
 *
 * docs/TESTNET.md ("Avatar art") walks through the upload and the deploy.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAvatar } from '@dicebear/core';
import { pixelArt } from '@dicebear/collection';

import { readDotEnv } from './lib/profile.mjs';

const OUT = fileURLToPath(new URL('../dist/avatars/', import.meta.url));
const env = readDotEnv();

/** Solid backgrounds, so the arena's circular mask never shows an empty corner. */
const BACKGROUNDS = {
  '1f2a44': 'Midnight',
  '2e5e4e': 'Pine',
  '6b3a5d': 'Plum',
  '8c4a2f': 'Rust',
  '3a6ea5': 'Sky',
  'c9a227': 'Gold',
  '4b4b5c': 'Slate',
  'a33b3b': 'Crimson',
};

/** The traits DiceBear reports, in the order a marketplace should list them. */
const TRAITS = ['hair', 'eyes', 'mouth', 'clothing', 'beard', 'glasses', 'hat', 'accessories'];

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
    else positional.push(argv[i]);
  }
  return { positional, flags };
}

function count(flags) {
  const n = Number(flags.count ?? env.AVATAR_MAX_SUPPLY ?? 100);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--count must be a positive integer, got ${flags.count}`);
  return n;
}

function draw(id) {
  return createAvatar(pixelArt, {
    seed: `lms-avatar-${id}`,
    size: 256,
    backgroundColor: Object.keys(BACKGROUNDS),
    backgroundType: ['solid'],
  }).toJson();
}

/** `long11` → `Long 11`, `variant03` → `Variant 03`. */
function label(value) {
  const spaced = String(value).replace(/([a-z])(\d)/gi, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function attributes(extra) {
  const background = String(extra.primaryBackgroundColor).replace(/^#/, '');
  const list = [{ trait_type: 'Background', value: BACKGROUNDS[background] ?? `#${background}` }];
  for (const trait of TRAITS) {
    if (extra[trait]) list.push({ trait_type: label(trait), value: label(extra[trait]) });
  }
  if (extra.skinColor) list.push({ trait_type: 'Skin', value: extra.skinColor });
  return list;
}

/** Writes into a fresh folder: a stale file from a bigger run would end up pinned too. */
function freshDir(name) {
  const dir = `${OUT}${name}/`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

function images(flags) {
  const n = count(flags);
  const dir = freshDir('images');
  for (let id = 1; id <= n; id++) writeFileSync(`${dir}${id}.svg`, draw(id).svg);
  console.log(`Wrote ${n} images to ${dir}`);
  console.log('Next: upload that folder (as a folder) to your pinning service, then');
  console.log('  npm run avatars -- metadata <the folder CID>');
}

function metadata(cid, flags) {
  if (!cid || cid.startsWith('ipfs://') || cid.includes('/')) {
    throw new Error('metadata needs the images folder CID alone, e.g. bafybei…');
  }
  const n = count(flags);
  const dir = freshDir('metadata');
  for (let id = 1; id <= n; id++) {
    const doc = {
      name: `LMS Avatar #${id}`,
      description: 'A cosmetic avatar worn in the Last Man Standing arena. Art: Pixel Art by DiceBear (CC0 1.0).',
      image: `ipfs://${cid}/${id}.svg`,
      attributes: attributes(draw(id).extra),
    };
    writeFileSync(`${dir}${id}`, `${JSON.stringify(doc, null, 2)}\n`);
  }
  console.log(`Wrote ${n} metadata files to ${dir}`);
  console.log('Next: upload that folder, then deploy with');
  console.log('  AVATAR_BASE_URI=ipfs://<the metadata folder CID>/   (the trailing slash matters)');
}

async function check(baseUri, flags) {
  if (!baseUri?.startsWith('ipfs://') || !baseUri.endsWith('/')) {
    throw new Error('check needs the base URI as deployed, e.g. ipfs://bafybei…/');
  }
  const gateway = env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
  const toHttp = (uri) => (uri.startsWith('ipfs://') ? `${gateway}${uri.slice('ipfs://'.length)}` : uri);
  const id = flags.id ?? '1';

  const metaUrl = toHttp(`${baseUri}${id}`);
  const meta = await fetch(metaUrl, { signal: AbortSignal.timeout(30_000) });
  if (!meta.ok) throw new Error(`${metaUrl}: HTTP ${meta.status}`);
  const doc = await meta.json();
  console.log(`metadata ok  ${metaUrl}\n  ${doc.name}, image ${doc.image}`);

  const imageUrl = toHttp(doc.image);
  const image = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
  if (!image.ok) throw new Error(`${imageUrl}: HTTP ${image.status}`);
  const type = image.headers.get('content-type') ?? '';
  console.log(`image ok     ${imageUrl}\n  ${type}, ${(await image.arrayBuffer()).byteLength} bytes`);
  if (!type.includes('svg')) console.warn('  warning: the gateway did not serve it as SVG; the arena may not draw it');
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command, arg] = positional;
try {
  if (command === 'images') images(flags);
  else if (command === 'metadata') metadata(arg, flags);
  else if (command === 'check') await check(arg, flags);
  else {
    console.error('usage: npm run avatars -- images | metadata <imagesCid> | check <baseUri> [--count N] [--id N]');
    process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
