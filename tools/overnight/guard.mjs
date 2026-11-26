// Scope guard for overnight item branches: `pnpm overnight:guard` compares the branch with origin/main
// and fails when the change touches something the unattended loop must not change by itself.
// Builder and reviewer both run it (docs/overnight/PROMPT.md). People changing the harness on purpose
// do not need it: it is not part of `pnpm overnight:check`.
import { execFileSync } from 'node:child_process';

const base = process.argv[2] ?? 'origin/main';
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** The gate, the rules and the supply chain: an item never edits these. */
export const PROTECTED = [
  /^\.github\//,
  /^CLAUDE\.md$/,
  /^docs\/overnight\/(PROMPT|REVIEWER)\.md$/,
  /^tools\/overnight\//,
  /^tools\/size-check\.mjs$/,
  /^tests\/e2e\/playtest\.spec\.ts$/,
  /^tests\/unit\/overnight\.test\.ts$/,
  /^playwright(\.perf)?\.config\.ts$/,
  /^vitest\.config\.ts$/,
  /^eslint\.config\.js$/,
  /^tsconfig(\.base)?\.json$/,
  /(^|\/)package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^\.npmrc$/,
  /^\.nvmrc$/,
];
/** Never commit these, whatever the item says. */
export const SECRETS = [/(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx|keystore)$/i, /(^|\/)(credentials|secrets?)\.(json|ya?ml)$/i, /(^|\/)id_(rsa|ed25519)/];
const SECRET_TEXT = /(-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-ant-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})/;
/** Added lines that often mean a check was switched off. They need a reason the reviewer accepts. */
const WEAKENERS = [/\b(test|it|describe)\.(skip|fixme|todo)\(/, /\.skipIf\(/, /eslint-disable/, /@ts-(ignore|expect-error|nocheck)/, /\bretries\s*:/, /\bas any\b/];
const ONLY = /\b(test|it|describe)\.only\(/;

function main() {
  const failures = [];
  const warnings = [];
  const names = git('diff', '--name-status', '--no-renames', `${base}...HEAD`).trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  if (names.length === 0) failures.push(`No changes against ${base}`);
  for (const [status, file] of names) {
    if (PROTECTED.some((re) => re.test(file))) failures.push(`protected file changed: ${file}`);
    if (SECRETS.some((re) => re.test(file))) failures.push(`looks like a secret: ${file}`);
    if (status === 'D' && /^tests\//.test(file)) failures.push(`test file deleted: ${file}`);
  }
  let file = '';
  let added = 0;
  let removed = 0;
  let removedExpects = 0;
  let addedExpects = 0;
  for (const line of git('diff', '--no-renames', '-U0', `${base}...HEAD`).split('\n')) {
    if (line.startsWith('+++ ')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
      const text = line.slice(1);
      if (SECRET_TEXT.test(text)) failures.push(`secret-looking text added in ${file}`);
      if (ONLY.test(text)) failures.push(`.only( added in ${file}: the rest of the suite would not run`);
      for (const re of WEAKENERS) if (re.test(text)) warnings.push(`${file}: ${text.trim().slice(0, 120)}`);
      if (/^tests\//.test(file) && /\bexpect\(/.test(text)) addedExpects++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
      if (/^tests\//.test(file) && /\bexpect\(/.test(line)) removedExpects++;
    }
  }
  if (removedExpects > 0) warnings.push(`${removedExpects} line(s) with expect( removed or changed under tests/ (${addedExpects} added): check no assertion was weakened`);
  console.info(`overnight:guard against ${base}: ${names.length} file(s), +${added} -${removed}`);
  for (const w of warnings) console.info(`WARN  ${w}`);
  for (const f of failures) console.error(`FAIL  ${f}`);
  console.info(failures.length ? 'GUARD RED' : warnings.length ? 'GUARD GREEN with warnings: each needs a reason in the pull request' : 'GUARD GREEN');
  process.exit(failures.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
