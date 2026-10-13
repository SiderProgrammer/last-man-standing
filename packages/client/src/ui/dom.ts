/**
 * The element registry.
 *
 * A factory rather than a module-level constant on purpose: as a constant it
 * ran at import time and threw unless the full `index.html` was already in the
 * document, which meant nothing in the client could be imported — by a test or
 * by anything else — without booting the whole app.
 */

function byId<T extends HTMLElement>(doc: Document, id: string): T {
  const element = doc.getElementById(id);
  // Fail loudly at boot rather than with a null dereference three interactions
  // later, and name the id so a renamed element is obvious.
  if (!element) throw new Error(`missing #${id} in index.html`);
  return element as T;
}

export function queryDom(doc: Document = document) {
  const el = <T extends HTMLElement>(id: string) => byId<T>(doc, id);
  return {
    connect: el<HTMLButtonElement>('connect'),
    chainLabel: el<HTMLSpanElement>('chain-label'),
    lobbyScreen: el<HTMLElement>('lobby-screen'),
    matchScreen: el<HTMLElement>('match-screen'),
    practice: el<HTMLButtonElement>('practice'),
    botCount: el<HTMLSelectElement>('bot-count'),
    refreshLobbies: el<HTMLButtonElement>('refresh-lobbies'),
    createLobby: el<HTMLButtonElement>('create-lobby'),
    stake: el<HTMLInputElement>('stake'),
    seats: el<HTMLSelectElement>('seats'),
    lobbyList: el<HTMLUListElement>('lobby-list'),
    payWithRow: el<HTMLDivElement>('pay-with-row'),
    payWith: el<HTMLSelectElement>('pay-with'),
    avatarChain: el<HTMLSpanElement>('avatar-chain'),
    avatarStatus: el<HTMLSpanElement>('avatar-status'),
    mintAvatar: el<HTMLButtonElement>('mint-avatar'),
    sessionState: el<HTMLSpanElement>('session-state'),
    sessionStatus: el<HTMLSpanElement>('session-status'),
    enableSession: el<HTMLButtonElement>('enable-session'),
    revokeSession: el<HTMLButtonElement>('revoke-session'),
    arena: el<HTMLDivElement>('arena'),
    phaseLabel: el<HTMLHeadingElement>('phase-label'),
    timer: el<HTMLSpanElement>('timer'),
    actionBar: el<HTMLDivElement>('action-bar'),
    targetRow: el<HTMLDivElement>('target-row'),
    target: el<HTMLSelectElement>('target'),
    lockIn: el<HTMLButtonElement>('lock-in'),
    moveStatus: el<HTMLParagraphElement>('move-status'),
    tabFeed: el<HTMLButtonElement>('tab-feed'),
    tabReads: el<HTMLButtonElement>('tab-reads'),
    feed: el<HTMLOListElement>('feed'),
    reads: el<HTMLDivElement>('reads'),
    winnings: el<HTMLSpanElement>('winnings'),
    collect: el<HTMLButtonElement>('collect'),
    collectStatus: el<HTMLSpanElement>('collect-status'),
    resultPanel: el<HTMLDivElement>('result-panel'),
    resultVerify: el<HTMLSpanElement>('result-verify'),
    resultRanking: el<HTMLOListElement>('result-ranking'),
    resultDetail: el<HTMLParagraphElement>('result-detail'),
    resultSettle: el<HTMLParagraphElement>('result-settle'),
    resultCollect: el<HTMLButtonElement>('result-collect'),
    resultBack: el<HTMLButtonElement>('result-back'),
    toast: el<HTMLDivElement>('toast'),
    loader: el<HTMLDivElement>('loader'),
    loaderBar: el<HTMLDivElement>('loader-bar'),
    loaderLabel: el<HTMLSpanElement>('loader-label'),
  };
}

export type Dom = ReturnType<typeof queryDom>;

/** Replaces a select's options, keeping the current value when it survives. */
export function fillSelect(select: HTMLSelectElement, options: Array<[string, string]>): void {
  const previous = select.value;
  select.replaceChildren(
    ...options.map(([value, label]) => {
      const option = select.ownerDocument.createElement('option');
      option.value = value;
      option.textContent = label;
      return option;
    }),
  );
  if (options.some(([value]) => value === previous)) select.value = previous;
}
