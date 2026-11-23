/**
 * mission-lint: validates every mission in content/missions against the Zod
 * schema, then checks references, objective fields and reachability against
 * the map, and finally the campaign as a whole (prerequisites, cycles, chains,
 * reachability from a new game).
 *
 *   pnpm mission-lint                 check everything against the generated city (CI)
 *   pnpm mission-lint --map <file>    check against another city spec or map JSON file
 *   pnpm mission-lint --write-schema  regenerate content/missions/mission.schema.json
 *   pnpm mission-lint --strict        warnings fail the run too
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { rawContent, rawMissions } from '@neonheat/content';
import { CrewsSchema, DialogueSchema, SquadsSchema, lintCampaign, lintMission, missionJsonSchema, parseMission, type LintIssue, type Mission } from '@neonheat/missions';
import { parseSimContent } from '@neonheat/sim';

const root = resolve(import.meta.dirname, '../../..');
const dir = join(root, 'content/missions');
const schemaPath = join(dir, 'mission.schema.json');
const schemaText = JSON.stringify(missionJsonSchema(), null, 2) + '\n';
const args = process.argv.slice(2);
const strict = args.includes('--strict');
const mapArg = args.includes('--map') ? args[args.indexOf('--map') + 1] : undefined;

if (args.includes('--write-schema')) {
  writeFileSync(schemaPath, schemaText);
  console.info(`wrote ${schemaPath}`);
}

let errors = 0;
let warnings = 0;
const fail = (msg: string): void => {
  errors++;
  console.error(`✗ ${msg}`);
};
const report = (file: string, i: LintIssue): void => {
  if (i.severity === 'warning' && !strict) {
    warnings++;
    console.warn(`! ${file} ${i.path}: ${i.message}`);
  } else fail(`${file} ${i.path}: ${i.message}`);
};

let current = '';
try {
  current = readFileSync(schemaPath, 'utf8');
} catch {
  /* missing */
}
if (current !== schemaText) fail('content/missions/mission.schema.json is out of date: run pnpm mission-lint --write-schema');

const raw = structuredClone(rawContent) as Record<string, unknown>;
if (mapArg) {
  raw.map = JSON.parse(readFileSync(resolve(process.cwd(), mapArg), 'utf8'));
  console.info(`mission-lint: using map ${mapArg}`);
}
const sim = parseSimContent(raw as typeof rawContent);
const crews = CrewsSchema.parse(rawContent.crews);
const ctx = {
  map: sim.map,
  vehicles: sim.vehicles,
  squads: SquadsSchema.parse(rawContent.squads),
  dialogue: DialogueSchema.parse(rawContent.dialogue),
  crews,
  heatMax: sim.heat.maxLevel,
};

const files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'mission.schema.json');
const ids = new Set<string>();
const missions: Mission[] = [];
for (const file of files) {
  let mission;
  try {
    mission = parseMission(JSON.parse(readFileSync(join(dir, file), 'utf8')), file);
  } catch (err) {
    fail(String(err instanceof Error ? err.message : err));
    continue;
  }
  missions.push(mission);
  if (`${mission.id}.json` !== file) fail(`${file}: id "${mission.id}" does not match the file name`);
  if (ids.has(mission.id)) fail(`${file}: duplicate mission id`);
  ids.add(mission.id);
  if (!(file in rawMissions)) fail(`${file}: not registered in content/index.ts rawMissions, so the game will not load it`);
  const issues = lintMission(mission, ctx);
  for (const i of issues) report(file, i);
  if (!issues.some((i) => i.severity === 'error')) console.info(`✓ ${file} (${mission.objectives.length} objectives, budget ${mission.budgetMinutes} min)`);
}
for (const i of lintCampaign(missions, crews)) report(`campaign[${i.mission}]`, i);

if (errors > 0) {
  console.error(`mission-lint: ${errors} problem(s), ${warnings} warning(s)`);
  process.exit(1);
}
console.info(`mission-lint: ${files.length} mission(s) OK${warnings ? `, ${warnings} warning(s)` : ''}`);
