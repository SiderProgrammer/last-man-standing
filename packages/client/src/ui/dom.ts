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
    topbarNav: el<HTMLElement>('topbar-nav'),
    navMenu: el<HTMLButtonElement>('nav-menu'),
    navLobby: el<HTMLButtonElement>('nav-lobby'),
    queueChip: el<HTMLButtonElement>('queue-chip'),
    winningsBadge: el<HTMLButtonElement>('winnings-badge'),
    heroNote: el<HTMLParagraphElement>('hero-note'),
    statusBar: el<HTMLDivElement>('status-bar'),
    txTray: el<HTMLDivElement>('tx-tray'),
    lobbyScreen: el<HTMLElement>('lobby-screen'),
    matchScreen: el<HTMLElement>('match-screen'),
    accountScreen: el<HTMLElement>('account-screen'),
    accountBack: el<HTMLButtonElement>('account-back'),
    theme: el<HTMLSelectElement>('theme'),
    accountAddress: el<HTMLParagraphElement>('account-address'),
    accountGuest: el<HTMLDivElement>('account-guest'),
    accountConnect: el<HTMLButtonElement>('account-connect'),
    guestPlay: el<HTMLButtonElement>('guest-play'),
    stakeRange: el<HTMLParagraphElement>('stake-range'),
    winningsPanel: el<HTMLDivElement>('winnings-panel'),
    pendingPrizes: el<HTMLParagraphElement>('pending-prizes'),
    practice: el<HTMLButtonElement>('practice'),
    botCount: el<HTMLSelectElement>('bot-count'),
    botDifficulty: el<HTMLSelectElement>('bot-difficulty'),
    refreshLobbies: el<HTMLButtonElement>('refresh-lobbies'),
    createLobby: el<HTMLButtonElement>('create-lobby'),
    stake: el<HTMLInputElement>('stake'),
    seats: el<HTMLSelectElement>('seats'),
    lobbyList: el<HTMLUListElement>('lobby-list'),
    queuePanel: el<HTMLDivElement>('queue-panel'),
    queueState: el<HTMLSpanElement>('queue-state'),
    queueTier: el<HTMLSelectElement>('queue-tier'),
    joinQueue: el<HTMLButtonElement>('join-queue'),
    leaveQueue: el<HTMLButtonElement>('leave-queue'),
    queueStatus: el<HTMLSpanElement>('queue-status'),
    notifyMe: el<HTMLButtonElement>('notify-me'),
    soundCues: el<HTMLInputElement>('sound-cues'),
    historyList: el<HTMLUListElement>('history-list'),
    historyMore: el<HTMLButtonElement>('history-more'),
    historyFilter: el<HTMLDivElement>('history-filter'),
    historyStats: el<HTMLSpanElement>('history-stats'),
    refreshHistory: el<HTMLButtonElement>('refresh-history'),
    avatarChain: el<HTMLSpanElement>('avatar-chain'),
    avatarStatus: el<HTMLSpanElement>('avatar-status'),
    mintAvatar: el<HTMLButtonElement>('mint-avatar'),
    avatarImage: el<HTMLImageElement>('avatar-image'),
    sessionState: el<HTMLSpanElement>('session-state'),
    sessionStatus: el<HTMLSpanElement>('session-status'),
    forgetSession: el<HTMLButtonElement>('forget-session'),
    oneClickState: el<HTMLSpanElement>('one-click-state'),
    oneClickStatus: el<HTMLSpanElement>('one-click-status'),
    enableOneClick: el<HTMLButtonElement>('enable-one-click'),
    disableOneClick: el<HTMLButtonElement>('disable-one-click'),
    stakingPanel: el<HTMLDivElement>('staking-panel'),
    stakingRewards: el<HTMLSpanElement>('staking-rewards'),
    claimRewards: el<HTMLButtonElement>('claim-rewards'),
    playRewards: el<HTMLSpanElement>('play-rewards'),
    claimPlayRewards: el<HTMLButtonElement>('claim-play-rewards'),
    vestingStatus: el<HTMLSpanElement>('vesting-status'),
    releaseVested: el<HTMLButtonElement>('release-vested'),
    stakingSummary: el<HTMLSpanElement>('staking-summary'),
    stakingAmount: el<HTMLInputElement>('staking-amount'),
    stakingMax: el<HTMLButtonElement>('staking-max'),
    stakeLms: el<HTMLButtonElement>('stake-lms'),
    unstakeLms: el<HTMLButtonElement>('unstake-lms'),
    unstakeStatus: el<HTMLSpanElement>('unstake-status'),
    withdrawUnstaked: el<HTMLButtonElement>('withdraw-unstaked'),
    delegationStatus: el<HTMLSpanElement>('delegation-status'),
    delegateTo: el<HTMLInputElement>('delegate-to'),
    delegateVotes: el<HTMLButtonElement>('delegate-votes'),
    undelegateVotes: el<HTMLButtonElement>('undelegate-votes'),
    stakingStatus: el<HTMLSpanElement>('staking-status'),
    stakingWrongChain: el<HTMLDivElement>('staking-wrong-chain'),
    stakingWrongChainText: el<HTMLSpanElement>('staking-wrong-chain-text'),
    stakingSwitch: el<HTMLButtonElement>('staking-switch'),
    navRules: el<HTMLButtonElement>('nav-rules'),
    navGovernance: el<HTMLButtonElement>('nav-governance'),
    governanceScreen: el<HTMLElement>('governance-screen'),
    governanceBack: el<HTMLButtonElement>('governance-back'),
    governanceStatus: el<HTMLSpanElement>('governance-status'),
    governanceWrongChain: el<HTMLDivElement>('governance-wrong-chain'),
    governanceWrongChainText: el<HTMLSpanElement>('governance-wrong-chain-text'),
    governanceSwitch: el<HTMLButtonElement>('governance-switch'),
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
    roundRecap: el<HTMLParagraphElement>('round-recap'),
    coach: el<HTMLParagraphElement>('coach'),
    roundAnnounce: el<HTMLParagraphElement>('round-announce'),
    actionBar: el<HTMLDivElement>('action-bar'),
    targetRow: el<HTMLDivElement>('target-row'),
    target: el<HTMLSelectElement>('target'),
    targetChips: el<HTMLDivElement>('target-chips'),
    lockIn: el<HTMLButtonElement>('lock-in'),
    holdMoves: el<HTMLInputElement>('hold-moves'),
    moveStatus: el<HTMLParagraphElement>('move-status'),
    moveRules: el<HTMLButtonElement>('move-rules'),
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
    resultVerify: el<HTMLButtonElement>('result-verify'),
    resultHeadline: el<HTMLDivElement>('result-headline'),
    resultPrize: el<HTMLParagraphElement>('result-prize'),
    resultRanking: el<HTMLOListElement>('result-ranking'),
    resultDetail: el<HTMLParagraphElement>('result-detail'),
    resultVerifyWhy: el<HTMLButtonElement>('result-verify-why'),
    resultSettle: el<HTMLParagraphElement>('result-settle'),
    resultDispute: el<HTMLButtonElement>('result-dispute'),
    resultCollect: el<HTMLButtonElement>('result-collect'),
    resultAnalyse: el<HTMLButtonElement>('result-analyse'),
    resultAgain: el<HTMLButtonElement>('result-again'),
    resultBack: el<HTMLButtonElement>('result-back'),
    helpDialog: el<HTMLDialogElement>('help-dialog'),
    helpClose: el<HTMLButtonElement>('help-close'),
    helpRules: el<HTMLElement>('help-rules'),
    helpRulesBody: el<HTMLDivElement>('help-rules-body'),
    helpVerify: el<HTMLElement>('help-verify'),
    helpStakes: el<HTMLElement>('help-stakes'),
    stakeIntro: el<HTMLDialogElement>('stake-intro'),
    stakeIntroBody: el<HTMLDivElement>('stake-intro-body'),
    stakeIntroSkip: el<HTMLInputElement>('stake-intro-skip'),
    stakeIntroGo: el<HTMLButtonElement>('stake-intro-go'),
    stakeIntroCancel: el<HTMLButtonElement>('stake-intro-cancel'),
    helpStakesBody: el<HTMLDivElement>('help-stakes-body'),
    toast: el<HTMLDivElement>('toast'),
    loader: el<HTMLDivElement>('loader'),
    loaderBar: el<HTMLDivElement>('loader-bar'),
    loaderLabel: el<HTMLSpanElement>('loader-label'),
  };
}

export type Dom = ReturnType<typeof queryDom>;

/**
 * A new element with a class and text. The one way the client builds markup:
 * text goes in as `textContent`, never as HTML, so nothing a server or another
 * player sends can become an element or a script.
 */
export function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

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
