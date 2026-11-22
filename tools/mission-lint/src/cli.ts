/**
 * mission-lint: validates every mission in content/missions against the Zod
 * schema, then checks references and reachability against the map.
 *
 *   pnpm mission-lint                 check everything (CI)
 *   pnpm mission-lint --write-schema  regenerate content/missions/mission.schema.json
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rawContent, rawMissions } from '@neonheat/content';
import { DialogueSchema, SquadsSchema, lintMission, missionJsonSchema, parseMission } from '@neonheat/missions';
import { parseSimContent } from '@neonheat/sim';

const root = resolve(import.meta.dirname, '../../..');
const dir = join(root, 'content/missions');
const schemaPath = join(dir, 'mission.schema.json');
const schemaText = JSON.stringify(missionJsonSchema(), null, 2) + '\n';

if (process.argv.includes('--write-schema')) {
  writeFileSync(schemaPath, schemaText);
  console.info(`wrote ${schemaPath}`);
}

let errors = 0;
const fail = (msg: string): void => {
  errors++;
  console.error(`✗ ${msg}`);
};

let current = '';
try {
  current = readFileSync(schemaPath, 'utf8');
} catch {
  /* missing */
}
if (current !== schemaText) fail('content/missions/mission.schema.json is out of date: run pnpm mission-lint --write-schema');

const sim = parseSimContent(structuredClone(rawContent));
const ctx = { map: sim.map, vehicles: sim.vehicles, squads: SquadsSchema.parse(rawContent.squads), dialogue: DialogueSchema.parse(rawContent.dialogue) };

const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'mission.schema.json');
const ids = new Set<string>();
for (const file of files) {
  let mission;
  try {
    mission = parseMission(JSON.parse(readFileSync(join(dir, file), 'utf8')), file);
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
    continue;
  }
  if (`${mission.id}.json` !== file) fail(`${file}: id "${mission.id}" does not match the file name`);
  if (ids.has(mission.id)) fail(`${file}: duplicate mission id`);
  ids.add(mission.id);
  if (!(file in rawMissions)) fail(`${file}: not registered in content/index.ts rawMissions, so the game will not load it`);
  const issues = lintMission(mission, ctx);
  for (const i of issues) fail(`${file} ${i.path}: ${i.message}`);
  if (issues.length === 0) console.info(`✓ ${file} (${mission.objectives.length} objectives, budget ${mission.budgetMinutes} min)`);
}
if (errors > 0) {
  console.error(`mission-lint: ${errors} problem(s)`);
  process.exit(1);
}
console.info(`mission-lint: ${files.length} mission(s) OK`);
