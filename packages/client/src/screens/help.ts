import { DEFAULT_RULES } from '@lms/consensus';
import { app, dom } from '../context.js';
import { element } from '../ui/dom.js';
import { rulesSheet, stakesSheet, type RulesSection } from '../ui/rules.js';
import { formatDuration } from '../ui/staking.js';
import { readRaw, writeRaw } from '../io/storage.js';

/**
 * The help dialog: how a round plays out, and what "verified in your browser"
 * on the result panel does and does not promise.
 */

export type HelpTopic = 'rules' | 'verify' | 'stakes';

export function openHelp(topic: HelpTopic = 'rules'): void {
  // The match's own rules when there is one: a lobby may run a different set.
  renderRules();
  if (!dom.helpDialog.open) dom.helpDialog.showModal();
  const target = topic === 'verify' ? dom.helpVerify : topic === 'stakes' ? dom.helpStakes : dom.helpRules;
  target.scrollIntoView({ block: 'start' });
}

export function wireHelpControls(): void {
  dom.navRules.onclick = () => openHelp('rules');
  dom.moveRules.onclick = () => openHelp('rules');
  dom.resultVerify.onclick = () => openHelp('verify');
  dom.resultVerifyWhy.onclick = () => openHelp('verify');
  dom.helpClose.onclick = () => dom.helpDialog.close();
  // A click on the backdrop lands on the dialog element itself, not its content.
  dom.helpDialog.onclick = (event) => {
    if (event.target === dom.helpDialog) dom.helpDialog.close();
  };
}

function renderRules(): void {
  fill(dom.helpRulesBody, rulesSheet(app.match?.rules ?? DEFAULT_RULES));
  fill(dom.helpStakesBody, stakesSheet(app.terms, formatDuration));
}

const STAKE_INTRO_KEY = 'lms:stake-intro-seen';

/**
 * The first time someone stakes: the fee, the split, the challenge window
 * and collecting, before their money moves. Resolves true to go on. Not
 * shown again once they tick "Don't show this again".
 */
export function confirmFirstStake(): Promise<boolean> {
  if (readRaw(STAKE_INTRO_KEY) === '1') return Promise.resolve(true);
  fill(dom.stakeIntroBody, stakesSheet(app.terms, formatDuration));
  dom.stakeIntroSkip.checked = true;
  return new Promise((resolve) => {
    const finish = (go: boolean) => {
      if (go && dom.stakeIntroSkip.checked) writeRaw(STAKE_INTRO_KEY, '1');
      dom.stakeIntro.onclose = null;
      dom.stakeIntro.close();
      resolve(go);
    };
    dom.stakeIntroGo.onclick = () => finish(true);
    dom.stakeIntroCancel.onclick = () => finish(false);
    // Esc closes the dialog: that is a "not now".
    dom.stakeIntro.onclose = () => resolve(false);
    dom.stakeIntro.showModal();
    dom.stakeIntroGo.focus();
  });
}

function fill(body: HTMLElement, sections: RulesSection[]): void {
  body.replaceChildren(
    ...sections.map((section) => {
      const block = element('div', `rule${section.tone ? ` ${section.tone}` : ''}`);
      block.append(element('h4', '', section.title), ...section.lines.map((line) => element('p', '', line)));
      return block;
    }),
  );
}
