// Reads and updates docs/overnight/backlog.json, the queue the overnight build loop works through.
//
//   node tools/overnight/backlog.mjs validate            check the file (part of the gate)
//   node tools/overnight/backlog.mjs next                print the first todo item as JSON, with its branch name
//   node tools/overnight/backlog.mjs list                one line per item
//   node tools/overnight/backlog.mjs done <id> <pr-url> [attempts]   status -> done, with the pull request
//   node tools/overnight/backlog.mjs block <id> "<why>" [attempts]   status -> blocked, with the reason
//
// Humans edit the JSON by hand as well: order in the file is priority order.
import { readFileSync, writeFileSync } from 'node:fs';

export const BACKLOG_PATH = new URL('../../docs/overnight/backlog.json', import.meta.url).pathname;
export const STATUSES = ['todo', 'done', 'blocked'];
export const SIZES = ['S', 'M'];
/** Consecutive failed attempts on one item before the loop gives up on it. */
export const MAX_ATTEMPTS = 3;

/** Returns a list of problems; empty when the backlog is valid. */
export function validate(backlog) {
  const errs = [];
  if (backlog?.version !== 1) errs.push('version must be 1');
  if (!Array.isArray(backlog?.items)) return [...errs, 'items must be an array'];
  const ids = new Set();
  backlog.items.forEach((it, i) => {
    const at = `items[${i}]${it?.id ? ` (${it.id})` : ''}`;
    const str = (k) => typeof it[k] === 'string' && it[k].trim().length > 0;
    if (!str('id') || !/^NH-\d{3}$/.test(it.id)) errs.push(`${at}: id must look like NH-001`);
    else if (ids.has(it.id)) errs.push(`${at}: duplicate id`);
    ids.add(it.id);
    if (!str('slug') || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(it.slug)) errs.push(`${at}: slug must be lower-case words joined by hyphens`);
    if (!str('title')) errs.push(`${at}: title is required`);
    if (!str('why')) errs.push(`${at}: why is required (where the item comes from)`);
    if (!SIZES.includes(it.size)) errs.push(`${at}: size must be one of ${SIZES.join(', ')} (anything bigger must be split)`);
    if (!STATUSES.includes(it.status)) errs.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    if (!Array.isArray(it.acceptance) || it.acceptance.length === 0 || !it.acceptance.every((a) => typeof a === 'string' && a.trim())) errs.push(`${at}: acceptance needs at least one criterion`);
    if (!Array.isArray(it.verify) || it.verify.length === 0 || !it.verify.every((a) => typeof a === 'string' && a.trim())) errs.push(`${at}: verify needs at least one command that proves the acceptance criteria`);
    if (!Number.isInteger(it.attempts) || it.attempts < 0) errs.push(`${at}: attempts must be a whole number`);
    if (it.pr !== null && !(typeof it.pr === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(it.pr))) errs.push(`${at}: pr must be null or a pull request URL`);
    if (typeof it.notes !== 'string') errs.push(`${at}: notes must be a string (may be empty)`);
    if (it.status === 'done' && !it.pr) errs.push(`${at}: a done item needs its pull request URL`);
    if (it.status === 'blocked' && !String(it.notes ?? '').trim()) errs.push(`${at}: a blocked item needs notes saying why`);
  });
  return errs;
}

/** The item the loop should work on: the first todo, in file order. */
export function nextItem(backlog) {
  return backlog.items.find((it) => it.status === 'todo') ?? null;
}

export function branchFor(item) {
  return `overnight/${item.id}-${item.slug}`;
}

const load = () => JSON.parse(readFileSync(BACKLOG_PATH, 'utf8'));
const save = (b) => writeFileSync(BACKLOG_PATH, `${JSON.stringify(b, null, 2)}\n`);
const today = () => new Date().toISOString().slice(0, 10);

function main() {
  const [cmd, id, arg, attemptsArg] = process.argv.slice(2);
  const backlog = load();
  const fail = (msg) => {
    console.error(msg);
    process.exit(1);
  };
  const errs = validate(backlog);
  if (errs.length) fail(`docs/overnight/backlog.json is invalid:\n- ${errs.join('\n- ')}`);
  const find = () => backlog.items.find((it) => it.id === id) ?? fail(`No item ${id}`);
  const note = (it, text) => {
    it.notes = [it.notes, `${today()}: ${text}`].filter((s) => s && s.trim()).join(' | ');
  };
  const setAttempts = (it) => {
    if (attemptsArg !== undefined) it.attempts = Number(attemptsArg);
  };
  const finish = () => {
    const after = validate(backlog);
    if (after.length) fail(`That change would make the backlog invalid:\n- ${after.join('\n- ')}`);
    save(backlog);
  };
  switch (cmd) {
    case 'validate': {
      const count = (s) => backlog.items.filter((it) => it.status === s).length;
      console.info(`backlog: ${backlog.items.length} items OK (${STATUSES.map((s) => `${count(s)} ${s}`).join(', ')})`);
      break;
    }
    case 'next': {
      const it = nextItem(backlog);
      console.info(JSON.stringify(it ? { ...it, branch: branchFor(it) } : null, null, 2));
      break;
    }
    case 'list':
      for (const it of backlog.items) console.info(`${it.id}  ${it.status.padEnd(11)} ${it.size}  ${it.title}${it.pr ? `  ${it.pr}` : ''}`);
      break;
    case 'done': {
      const it = find();
      it.status = 'done';
      it.pr = arg ?? null;
      setAttempts(it);
      finish();
      console.info(`${id} done: ${it.pr}`);
      break;
    }
    case 'block': {
      const it = find();
      if (!arg) fail('Say why it is blocked');
      it.status = 'blocked';
      setAttempts(it);
      note(it, `blocked: ${arg}`);
      finish();
      console.info(`${id} blocked`);
      break;
    }
    default:
      fail('Usage: backlog.mjs validate | next | list | done <id> <pr-url> [attempts] | block <id> "<why>" [attempts]');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
