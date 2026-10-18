import { MAX_QUESTION_CHARS, type MatchAnalysis, type ServerMessage } from '@lms/protocol';
import { app, dom, net } from '../context.js';
import { analysisNote, errorText, momentHeading, paragraphs } from '../ui/analysis.js';

/**
 * The analysis tab: asks the server to analyse the finished match, shows the
 * narrative as it streams in, then the checked key moments — each of which
 * replays its round in the arena when clicked — and the advice.
 *
 * Once the analysis is in, the player can ask follow-up questions under it.
 * Only the question is sent; the server holds the conversation.
 *
 * Off the game's path entirely. It runs only after the result is in, sends
 * nothing but the request, and nothing it receives touches the match state.
 */

/** Match the panel is showing, or null before any match has finished. */
let current: `0x${string}` | null = null;
let streamed = '';
/** The answer being written to the question in flight, if any. */
let pending: { answer: HTMLParagraphElement; text: string } | null = null;
let replayRound: (round: number) => void = () => undefined;
let showTab: () => void = () => undefined;

export function wireAnalysisControls(options: { replay: (round: number) => void; showTab: () => void }): void {
  replayRound = options.replay;
  showTab = options.showTab;
  dom.analyse.onclick = () => requestAnalysis();
  dom.resultAnalyse.onclick = () => {
    showTab();
    if (!dom.analyse.disabled) requestAnalysis();
  };
  dom.analysisAsk.onsubmit = (event) => {
    event.preventDefault();
    askQuestion();
  };
}

/** A new match is on screen: forget the last one's analysis. */
export function resetAnalysis(): void {
  current = null;
  streamed = '';
  clear();
  setStatus('Available once the match is over.');
  dom.analyse.disabled = true;
  dom.resultAnalyse.classList.add('hidden');
}

/** The match finished: offer an analysis, or say why there is none. */
export function offerAnalysis(matchId: `0x${string}`): void {
  current = matchId;
  streamed = '';
  clear();
  if (!app.analyst) {
    dom.analyse.disabled = true;
    setStatus('Analysis is not available on this server.');
    return;
  }
  dom.analyse.disabled = false;
  dom.resultAnalyse.classList.remove('hidden');
  setStatus('Ask Claude to walk through the match and point out what decided it.');
}

function askQuestion(): void {
  const question = dom.analysisQuestion.value.trim().slice(0, MAX_QUESTION_CHARS);
  if (!current || !question || pending) return;

  const item = document.createElement('li');
  const asked = document.createElement('p');
  asked.className = 'question';
  asked.textContent = question;
  const answer = document.createElement('p');
  answer.className = 'muted';
  answer.textContent = '…';
  item.append(asked, answer);
  dom.analysisThread.append(item);
  item.scrollIntoView({ block: 'nearest' });

  pending = { answer, text: '' };
  setAsking(true);
  dom.analysisQuestion.value = '';
  net.send({ type: 'analysis.ask', matchId: current, question });
}

export function onAnalysisReplyDelta(message: Extract<ServerMessage, { type: 'analysis.reply.delta' }>): void {
  if (message.matchId !== current || !pending) return;
  pending.text += message.text;
  pending.answer.className = '';
  pending.answer.textContent = pending.text;
}

export function onAnalysisReply(message: Extract<ServerMessage, { type: 'analysis.reply' }>): void {
  if (message.matchId !== current || !pending) return;
  // The whole answer replaces what streamed, as for the analysis.
  pending.answer.className = '';
  pending.answer.textContent = message.answer;
  pending = null;
  setAsking(false);
  setStatus('');
}

function setAsking(asking: boolean): void {
  dom.analysisQuestion.disabled = asking;
  dom.analysisAskButton.disabled = asking;
  if (!asking) dom.analysisQuestion.focus();
}

function requestAnalysis(): void {
  if (!current || !app.analyst) return;
  streamed = '';
  clear();
  dom.analyse.disabled = true;
  dom.resultAnalyse.classList.add('hidden');
  setStatus('Reading the match…');
  net.send({ type: 'analyze', matchId: current });
}

export function onAnalysisStep(message: Extract<ServerMessage, { type: 'analysis.step' }>): void {
  if (message.matchId !== current) return;
  setStatus(`${message.step}…`);
}

export function onAnalysisDelta(message: Extract<ServerMessage, { type: 'analysis.delta' }>): void {
  if (message.matchId !== current) return;
  streamed += message.text;
  setStatus('Writing…');
  renderSummary(streamed);
}

export function onAnalysisDone(message: Extract<ServerMessage, { type: 'analysis.done' }>): void {
  if (message.analysis.matchId !== current) return;
  // The final text replaces whatever streamed: it is the parsed, checked answer.
  renderAnalysis(message.analysis);
  dom.analysisNote.textContent = analysisNote(message.analysis, message.cached);
  dom.analysisAsk.classList.remove('hidden');
  setStatus('');
}

export function onAnalysisError(message: Extract<ServerMessage, { type: 'analysis.error' }>): void {
  if (message.matchId !== current) return;
  if (message.stage === 'ask') {
    // A failed question leaves the analysis where it is.
    if (pending) {
      pending.answer.className = 'warn-text';
      pending.answer.textContent = errorText(message.code, message.message).text;
      pending = null;
    }
    setAsking(false);
    setStatus('');
    return;
  }
  // Anything streamed before the failure is not an answer; drop it.
  streamed = '';
  clear();
  const { text, retry } = errorText(message.code, message.message);
  setStatus(text);
  dom.analyse.disabled = !retry;
  dom.analyse.textContent = retry ? 'Try again' : 'Analyse match';
}

function renderAnalysis(analysis: MatchAnalysis): void {
  renderSummary(analysis.summary);

  dom.analysisMoments.replaceChildren(
    ...analysis.keyMoments.map((moment) => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.className = 'moment';
      button.title = `Replay round ${moment.round}`;
      const heading = document.createElement('span');
      heading.className = 'moment-head';
      heading.textContent = momentHeading(moment);
      const claim = document.createElement('span');
      claim.textContent = moment.claim;
      button.append(heading, claim);
      if (moment.round === analysis.decisiveRound) button.classList.add('decisive');
      button.onclick = () => replayRound(moment.round);
      item.append(button);
      return item;
    }),
  );
  dom.analysisMomentsHead.classList.toggle('hidden', analysis.keyMoments.length === 0);

  dom.analysisAdvice.replaceChildren(
    ...analysis.advice.map((tip) => {
      const item = document.createElement('li');
      item.textContent = tip;
      return item;
    }),
  );
  dom.analysisAdviceHead.classList.toggle('hidden', analysis.advice.length === 0);
  dom.analyse.textContent = 'Analyse match';
}

function renderSummary(summary: string): void {
  dom.analysisSummary.replaceChildren(
    ...paragraphs(summary).map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }),
  );
}

function clear(): void {
  pending = null;
  dom.analysisThread.replaceChildren();
  dom.analysisAsk.classList.add('hidden');
  setAsking(false);
  dom.analysisSummary.replaceChildren();
  dom.analysisMoments.replaceChildren();
  dom.analysisAdvice.replaceChildren();
  dom.analysisMomentsHead.classList.add('hidden');
  dom.analysisAdviceHead.classList.add('hidden');
  dom.analysisNote.textContent = '';
}

function setStatus(text: string): void {
  dom.analysisStatus.textContent = text;
}
