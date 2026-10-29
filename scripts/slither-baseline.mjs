#!/usr/bin/env node
/**
 * Fails when Slither reports a finding the triaged baseline does not list.
 *
 *   node scripts/slither-baseline.mjs contracts/slither.json contracts/slither-baseline.json
 *   node scripts/slither-baseline.mjs contracts/slither.json contracts/slither-baseline.json --update
 *
 * The first argument is Slither's `--json` output, the second the baseline.
 * `--update` rewrites the baseline from the current findings instead of
 * checking. It keeps the `triage` note of every finding still present and
 * leaves new ones without a note, which the check then refuses, so nothing
 * enters the baseline without someone writing down why it is acceptable.
 *
 * Slither's own finding `id` hashes the description, which carries line
 * numbers, so any edit above a known finding would make it look new. The key
 * here is the detector plus the qualified names of the elements it points at,
 * which survives unrelated edits and still changes when the finding moves to
 * different code.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const [reportPath, baselinePath, flag] = process.argv.slice(2);
if (!reportPath || !baselinePath) {
  console.error('usage: slither-baseline.mjs <slither.json> <baseline.json> [--update]');
  process.exit(2);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
if (!report.success) {
  console.error(`Slither failed: ${report.error ?? 'no error message'}`);
  process.exit(2);
}

const findings = (report.results?.detectors ?? []).map((detector) => ({
  key: keyOf(detector),
  impact: detector.impact,
  summary: detector.description.split('\n')[0].trim(),
}));

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')) : [];
const triage = new Map(baseline.map((finding) => [finding.key, finding.triage]));

if (flag === '--update') {
  const unique = [...new Map(findings.map((finding) => [finding.key, finding])).values()];
  unique.sort((a, b) => a.key.localeCompare(b.key));
  const entries = unique.map((finding) => ({ ...finding, triage: triage.get(finding.key) ?? '' }));
  writeFileSync(baselinePath, `${JSON.stringify(entries, null, 2)}\n`);
  const untriaged = entries.filter((entry) => !entry.triage).length;
  console.log(`Wrote ${entries.length} findings to ${baselinePath}; ${untriaged} still need a triage note.`);
  process.exit(0);
}

const fresh = findings.filter((finding) => !triage.has(finding.key));
const untriaged = baseline.filter((finding) => !finding.triage);
const stale = baseline.filter((entry) => !findings.some((finding) => finding.key === entry.key));

for (const entry of stale) console.log(`fixed (remove from the baseline): ${entry.key}`);
for (const finding of fresh) console.error(`new ${finding.impact} finding: ${finding.summary}\n  key: ${finding.key}`);
for (const entry of untriaged) console.error(`no triage note: ${entry.key}`);
if (fresh.length === 0 && untriaged.length === 0) {
  console.log(`No new Slither findings (${findings.length} known).`);
  process.exit(0);
}
console.error(
  `\n${fresh.length} new finding(s), ${untriaged.length} without a triage note. ` +
    'Fix them, or run with --update and write a triage note for each.',
);
process.exit(1);

function keyOf(detector) {
  const elements = (detector.elements ?? []).map((element) => `${element.type}:${qualifiedName(element)}`);
  return [detector.check, ...[...new Set(elements)].sort()].join('|');
}

/** `Contract.function.name`, from the element's chain of parents. */
function qualifiedName(element) {
  const parts = [element.name];
  let parent = element.type_specific_fields?.parent;
  while (parent) {
    parts.unshift(parent.name);
    parent = parent.type_specific_fields?.parent;
  }
  return parts.join('.');
}
