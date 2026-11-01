import { DEFAULT_RULES } from '@lms/consensus';
import { app, dom } from '../context.js';
import { rulesSheet } from '../ui/rules.js';

/**
 * The help dialog: how a round plays out, and what "verified in your browser"
 * on the result panel does and does not promise.
 */

export type HelpTopic = 'rules' | 'verify';

export function openHelp(topic: HelpTopic = 'rules'): void {
  // The match's own rules when there is one: a lobby may run a different set.
  renderRules();
  if (!dom.helpDialog.open) dom.helpDialog.showModal();
  const target = topic === 'verify' ? dom.helpVerify : dom.helpRules;
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
  const sections = rulesSheet(app.match?.rules ?? DEFAULT_RULES);
  dom.helpRulesBody.replaceChildren(
    ...sections.map((section) => {
      const block = document.createElement('div');
      block.className = `rule${section.tone ? ` ${section.tone}` : ''}`;
      const title = document.createElement('h4');
      title.textContent = section.title;
      block.append(title);
      for (const line of section.lines) {
        const text = document.createElement('p');
        text.textContent = line;
        block.append(text);
      }
      return block;
    }),
  );
}
