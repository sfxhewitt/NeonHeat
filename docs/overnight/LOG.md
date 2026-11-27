# Overnight build log

One dated section per night, newest at the bottom. The format is in `docs/overnight/PROMPT.md`, section 7.
Entries are written inside the pull request they describe, so an entry is on `main` only if that pull request merged.

## 2026-11-26

### NH-001 Guard the IP rules with a test — shipped
- Pull request: https://github.com/sfxhewitt/NeonHeat/pull/9
- What changed: new `tests/unit/ip-rules.test.ts` scans tracked text files under apps/, packages/, content/ and assets/ for the banned series and publisher names and proves the scanner on an in-memory sample. No shipped file changed.
- Gate: GATE GREEN, 10 steps, 526.6 s. Playtest: frame avg 23.8 ms, p95 33.4 ms, worst 50 ms, 47 draw calls. Unit: 342 tests. Bundle: 1257.8 KB gzip.
- Review: none independent. This session could not start a reviewer subagent; the launching session told it to self-review adversarially and merge only a small, fully green change that touches no save format. That is not an independent review.
- Attempts: 1. Failed: nothing on the item. The first baseline gate on untouched main went red: `living-city.test.ts` "keeps the tick cheap" measured 9.06 ms per tick against a 4 ms limit while other sessions' browsers held the 2-core machine at load 8 to 14; CI on the same commit was green. The gate was run once more when the load had dropped below 1.5 and was green (601.8 s).
- Skipped: the independent reviewer (see above).
- Flakes: `tests/unit/living-city.test.ts` > living city performance > runs 60 s with everything on and keeps the tick cheap (wall-clock timing under machine load).
