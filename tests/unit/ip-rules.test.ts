import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * CLAUDE.md, IP rules (hard): the series' abbreviation, its full name and its publisher's name never ship
 * in code, assets, copy or comments. The terms are assembled here so this file does not contain them.
 */
const root = new URL('../../', import.meta.url).pathname;
const SCANNED = ['apps', 'packages', 'content', 'assets'];

const word = (...parts: string[]): string => parts.join('');
const BANNED = [
  word('G', 'T', 'A'),
  `${word('Gr', 'and')}\\s+${word('Th', 'eft')}(?:\\s+${word('Au', 'to')})?`,
  word('Rock', 'star'),
];
const PATTERN = new RegExp(`\\b(?:${BANNED.join('|')})\\b`, 'gi');

interface Hit {
  file: string;
  line: number;
  text: string;
}

/** Every banned term in `text`, with its line number. */
function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(PATTERN)) hits.push({ file, line: i + 1, text: m[0] });
  });
  return hits;
}

const tracked = (): string[] =>
  execFileSync('git', ['ls-files', '-z', '--', ...SCANNED], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);

describe('IP rules', () => {
  it('the scanner finds a banned term in any case, as a whole word only', () => {
    const sample = [`const title = '${word('g', 't', 'a')} clone';`, `// by ${word('ROCK', 'STAR')}`, `${word('Grand', ' ', 'theft')}  ${word('auto')}`, 'legtape, rockstarry'].join('\n');
    expect(scan('sample.ts', sample).map((h) => h.line)).toEqual([1, 2, 3]);
  });

  it('no tracked text file under apps, packages, content or assets names the series or its publisher', () => {
    const files = tracked();
    expect(files.length).toBeGreaterThan(100);
    const hits: Hit[] = [];
    let scanned = 0;
    for (const file of files) {
      const buf = readFileSync(join(root, file));
      if (buf.includes(0)) continue; // binary (fonts, images)
      scanned++;
      hits.push(...scan(file, buf.toString('utf8')));
    }
    expect(scanned).toBeGreaterThan(100);
    expect(hits.map((h) => `${h.file}:${h.line}`)).toEqual([]);
  });
});
