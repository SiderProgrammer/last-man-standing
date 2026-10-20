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
    stakingPanel: el<HTMLDivElement>('staking-panel'),
    stakingRewards: el<HTMLSpanElement>('staking-rewards'),
    claimRewards: el<HTMLButtonElement>('claim-rewards'),
    stakingSummary: el<HTMLSpanElement>('staking-summary'),
    stakingAmount: el<HTMLInputElement>('staking-amount'),
    stakingMax: el<HTMLButtonElement>('staking-max'),
    stakeLms: el<HTMLButtonElement>('stake-lms'),
    unstakeLms: el<HTMLButtonElement>('unstake-lms'),
    unstakeStatus: el<HTMLSpanElement>('unstake-status'),
    withdrawUnstaked: el<HTMLButtonElement>('withdraw-unstaked'),
    stakingStatus: el<HTMLSpanElement>('staking-status'),
    navGovernance: el<HTMLButtonElement>('nav-governance'),
    governanceScreen: el<HTMLElement>('governance-screen'),
    governanceBack: el<HTMLButtonElement>('governance-back'),
    governanceStatus: el<HTMLSpanElement>('governance-status'),
    proposalList: el<HTMLUListElement>('proposal-list'),
    newProposal: el<HTMLButtonElement>('new-proposal'),
    proposalForm: el<HTMLDivElement>('proposal-form'),
    proposerPower: el<HTMLSpanElement>('proposer-power'),
    proposalTitle: el<HTMLInputElement>('proposal-title'),
    proposalBody: el<HTMLTextAreaElement>('proposal-body'),
    draftActions: el<HTMLOListElement>('draft-actions'),
    actionTemplate: el<HTMLSelectElement>('action-template'),
    actionHelp: el<HTMLParagraphElement>('action-help'),
    actionFields: el<HTMLDivElement>('action-fields'),
    addAction: el<HTMLButtonElement>('add-action'),
    actionError: el<HTMLSpanElement>('action-error'),
    submitProposal: el<HTMLButtonElement>('submit-proposal'),
    cancelProposal: el<HTMLButtonElement>('cancel-proposal'),
    proposalStatus: el<HTMLSpanElement>('proposal-status'),
    arena: el<HTMLDivElement>('arena'),
    movePanel: el<HTMLDivElement>('move-panel'),
    phaseLabel: el<HTMLHeadingElement>('phase-label'),
    timer: el<HTMLSpanElement>('timer'),
    timerBar: el<HTMLDivElement>('timer-bar'),
    actionBar: el<HTMLDivElement>('action-bar'),
    targetRow: el<HTMLDivElement>('target-row'),
    target: el<HTMLSelectElement>('target'),
    targetChips: el<HTMLDivElement>('target-chips'),
    lockIn: el<HTMLButtonElement>('lock-in'),
    holdMoves: el<HTMLInputElement>('hold-moves'),
    moveStatus: el<HTMLParagraphElement>('move-status'),
    tabFeed: el<HTMLButtonElement>('tab-feed'),
    tabReads: el<HTMLButtonElement>('tab-reads'),
    tabAnalysis: el<HTMLButtonElement>('tab-analysis'),
    feed: el<HTMLOListElement>('feed'),
    reads: el<HTMLDivElement>('reads'),
    analysis: el<HTMLDivElement>('analysis'),
    analyse: el<HTMLButtonElement>('analyse'),
    analysisStatus: el<HTMLSpanElement>('analysis-status'),
    analysisSteps: el<HTMLOListElement>('analysis-steps'),
    analysisSummary: el<HTMLDivElement>('analysis-summary'),
    analysisMomentsHead: el<HTMLHeadingElement>('analysis-moments-head'),
    analysisMoments: el<HTMLOListElement>('analysis-moments'),
    analysisAdviceHead: el<HTMLHeadingElement>('analysis-advice-head'),
    analysisAdvice: el<HTMLUListElement>('analysis-advice'),
    analysisNote: el<HTMLParagraphElement>('analysis-note'),
    winnings: el<HTMLSpanElement>('winnings'),
    collect: el<HTMLButtonElement>('collect'),
    collectStatus: el<HTMLSpanElement>('collect-status'),
    resultPanel: el<HTMLDivElement>('result-panel'),
    resultVerify: el<HTMLSpanElement>('result-verify'),
    resultHeadline: el<HTMLDivElement>('result-headline'),
    resultRanking: el<HTMLOListElement>('result-ranking'),
    resultDetail: el<HTMLParagraphElement>('result-detail'),
    resultSettle: el<HTMLParagraphElement>('result-settle'),
    resultCollect: el<HTMLButtonElement>('result-collect'),
    resultAnalyse: el<HTMLButtonElement>('result-analyse'),
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
