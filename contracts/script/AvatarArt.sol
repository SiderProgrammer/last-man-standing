// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Where every `PlayerAvatars` collection's metadata lives unless
// `AVATAR_BASE_URI` says otherwise: the 100 Pixel Art avatars made by
// `npm run avatars` and pinned on 13 Nov 2026 (docs/TESTNET.md, "Avatar art").
// Shared by every deploy, so a local fork or a fresh testnet collection has the
// same art as the live ones. Covers token ids 1–100: a collection with a larger
// `maxSupply` needs more files pinned first.
string constant AVATAR_ART_BASE_URI = "ipfs://bafybeiecqvujd6j7zh7l2zibk3lvimlxbetkzh4wgrrf73fqgd7p5vnbuq/";
