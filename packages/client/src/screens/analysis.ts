import type { MatchAnalysis, ServerMessage } from '@lms/api';
import { app, dom, net } from '../context.js';
import { analysisNote, errorText, momentHeading, paragraphs, progressText } from '../ui/analysis.js';

/**
 * The analysis tab: asks the server to analyse the finished match, then shows
 * the narrative, the checked key moments — each of which replays its round in
 * the arena when clicked — and the advice.
 *
 * Off the game's path entirely. It runs only after the result is in, sends
 * nothing but the request, and nothing it receives touches the match state.
 */

/** Match the panel is showing, or null before any match has finished. */
let current: `0x${string}` | null = null;
/** Ticks the elapsed time while an analysis is being written. */
let progress: ReturnType<typeof setInterval> | null = null;
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
}

/** A new match is on screen: forget the last one's analysis. */
export function resetAnalysis(): void {
  current = null;
  stopProgress();
  clear();
  setStatus('Available once the match is over.');
  dom.analyse.disabled = true;
  dom.resultAnalyse.classList.add('hidden');
}

/** The match finished: offer an analysis, or say why there is none. */
export function offerAnalysis(matchId: `0x${string}`): void {
  current = matchId;
  clear();
  if (!app.analyst) {
    dom.analyse.disabled = true;
    setStatus('Analysis is not available on this server.');
    return;
  }
  dom.analyse.disabled = false;
  dom.resultAnalyse.classList.remove('hidden');
  setStatus('Ask the analyst to walk through the match and point out what decided it.');
}

function requestAnalysis(): void {
  if (!current || !app.analyst) return;
  clear();
  dom.analyse.disabled = true;
  dom.resultAnalyse.classList.add('hidden');
  startProgress();
  addStep('Sending the match to the analyst');
  net.send({ type: 'analyze', matchId: current });
}

export function onAnalysisStep(message: Extract<ServerMessage, { type: 'analysis.step' }>): void {
  if (message.matchId !== current || progress === null) return;
  addStep(message.step);
}

/** Marks the step before as done and shows this one as current. */
function addStep(text: string): void {
  for (const item of dom.analysisSteps.children) item.classList.remove('current');
  const item = document.createElement('li');
  item.className = 'current';
  item.textContent = text;
  dom.analysisSteps.append(item);
  dom.analysisSteps.classList.remove('hidden');
}

function startProgress(): void {
  stopProgress();
  const started = Date.now();
  const tick = () => setStatus(progressText(Math.floor((Date.now() - started) / 1000)));
  tick();
  progress = setInterval(tick, 1_000);
}

function stopProgress(): void {
  if (progress !== null) clearInterval(progress);
  progress = null;
}

export function onAnalysisDone(message: Extract<ServerMessage, { type: 'analysis.done' }>): void {
  if (message.analysis.matchId !== current) return;
  stopProgress();
  clearSteps();
  renderAnalysis(message.analysis);
  dom.analysisNote.textContent = analysisNote(message.analysis, message.cached);
  setStatus('');
}

export function onAnalysisError(message: Extract<ServerMessage, { type: 'analysis.error' }>): void {
  if (message.matchId !== current) return;
  stopProgress();
  clear();
  const { text, retry } = errorText(message.code, message.message);
  setStatus(text);
  dom.analyse.disabled = !retry;
  dom.analyse.textContent = retry ? 'Try again' : 'Analyse match';
}

function renderAnalysis(analysis: MatchAnalysis): void {
  dom.analysisSummary.replaceChildren(
    ...paragraphs(analysis.summary).map((text) => {
      const p = document.createElement('p');
      p.textContent = text;
      return p;
    }),
  );

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

function clearSteps(): void {
  dom.analysisSteps.replaceChildren();
  dom.analysisSteps.classList.add('hidden');
}

function clear(): void {
  clearSteps();
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
