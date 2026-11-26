import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The overnight build loop's own guard rails (docs/overnight/PROMPT.md): the backlog is well formed,
 * the local gate runs everything CI runs, and the workflows stay pinned.
 */
const root = new URL('../../', import.meta.url).pathname;
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

interface BacklogItem {
  id: string;
  slug: string;
  status: string;
  size: string;
  attempts: number;
  pr: string | null;
  notes: string;
  acceptance: string[];
  verify: string[];
}
interface Backlog {
  version: number;
  items: BacklogItem[];
}
interface BacklogTool {
  validate: (b: unknown) => string[];
  nextItem: (b: Backlog) => BacklogItem | null;
  branchFor: (i: BacklogItem) => string;
  MAX_ATTEMPTS: number;
}
interface CheckTool {
  STEPS: { name: string; cmd: string }[];
  LOOSENERS: string[];
}
const tool = (await import(join(root, 'tools/overnight/backlog.mjs'))) as BacklogTool;
const check = (await import(join(root, 'tools/overnight/check.mjs'))) as CheckTool;
const backlog = JSON.parse(read('docs/overnight/backlog.json')) as Backlog;

describe('overnight backlog', () => {
  it('is valid', () => {
    expect(tool.validate(backlog)).toEqual([]);
  });

  it('rejects malformed items', () => {
    const good = backlog.items[0]!;
    const bad = (patch: Partial<BacklogItem>): string[] => tool.validate({ version: 1, items: [{ ...good, ...patch }] });
    expect(bad({})).toEqual([]);
    expect(bad({ id: 'seven' })).not.toEqual([]);
    expect(bad({ size: 'XL' })).not.toEqual([]);
    expect(bad({ status: 'in_progress' })).not.toEqual([]);
    expect(bad({ acceptance: [] })).not.toEqual([]);
    expect(bad({ verify: [] })).not.toEqual([]);
    expect(bad({ status: 'done', pr: null })).not.toEqual([]);
    expect(bad({ status: 'blocked', notes: '' })).not.toEqual([]);
    expect(tool.validate({ version: 1, items: [good, good] })).not.toEqual([]);
  });

  it('hands out the first item that is not done or blocked', () => {
    const a = { ...backlog.items[0]!, status: 'done', pr: 'https://github.com/o/r/pull/1' };
    const b = { ...backlog.items[1]!, status: 'blocked', notes: 'why' };
    const c = { ...backlog.items[2]!, status: 'todo' };
    expect(tool.nextItem({ version: 1, items: [a, b, c] })?.id).toBe(c.id);
    expect(tool.nextItem({ version: 1, items: [a, b] })).toBeNull();
    expect(tool.branchFor(c)).toBe(`overnight/${c.id}-${c.slug}`);
    expect(tool.MAX_ATTEMPTS).toBe(3);
  });
});

describe('overnight gate', () => {
  const ci = read('.github/workflows/ci.yml');

  it('runs every check CI runs', () => {
    const ciCommands = [...ci.matchAll(/^\s+run: (pnpm (?!install|exec playwright install)\S.*)$/gm)].map((m) => m[1]!);
    expect(ciCommands.length).toBeGreaterThanOrEqual(7);
    const gate = check.STEPS.map((s) => s.cmd);
    for (const cmd of ciCommands) {
      // The gate splits `pnpm e2e` into the smoke playtest and the other projects; together they are the same run.
      if (cmd === 'pnpm e2e') {
        const config = read('playwright.config.ts');
        const projects = [...config.matchAll(/name: '([\w-]+)'/g)].map((m) => m[1]!);
        const e2e = gate.find((c) => c.includes('--project='))!;
        const covered = new Set([...e2e.matchAll(/--project=([\w-]+)/g)].map((m) => m[1]!));
        expect(gate).toContain('pnpm playtest');
        covered.add('playtest');
        expect([...covered].sort()).toEqual([...projects].sort());
      } else {
        expect(gate, `the gate is missing "${cmd}"`).toContain(cmd);
      }
    }
    for (const required of ['pnpm lint', 'pnpm typecheck', 'pnpm test', 'pnpm build', 'pnpm playtest']) expect(gate).toContain(required);
  });

  it('refuses the environment variables that loosen a budget', () => {
    expect(check.LOOSENERS).toEqual(expect.arrayContaining(['FRAME_BUDGET_MS', 'SIZE_BUDGET_KB']));
  });

  it('has a package script', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['overnight:check']).toBe('node tools/overnight/check.mjs');
    expect(pkg.scripts.playtest).toContain('--project=playtest');
  });
});

describe('supply chain', () => {
  const dir = join(root, '.github/workflows');
  const workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));

  it('pins every GitHub Action to a full commit SHA with a version comment', () => {
    let uses = 0;
    for (const f of workflows) {
      for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
        const m = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
        if (!m) continue;
        uses++;
        expect(m[1], `${f}: ${line.trim()}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(m[2], `${f}: ${line.trim()} needs a "# vX.Y.Z" comment`).toMatch(/^\s+# v\d+\.\d+\.\d+$/);
      }
    }
    expect(uses).toBeGreaterThanOrEqual(8);
  });

  it('installs dependencies from the frozen lockfile only', () => {
    for (const f of workflows) {
      const installs = readFileSync(join(dir, f), 'utf8')
        .split('\n')
        .filter((l) => /\b(pnpm|npm|yarn)\s+(install|add|i|ci)\b/.test(l));
      expect(installs.length, `${f} installs dependencies`).toBeGreaterThan(0);
      for (const l of installs) expect(l, f).toMatch(/pnpm install --frozen-lockfile\s*$/);
    }
    expect(read('package.json')).toMatch(/"packageManager": "pnpm@\d+\.\d+\.\d+"/);
  });
});
