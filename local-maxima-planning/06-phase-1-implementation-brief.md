# 06 — Phase 1 Agent Implementation Brief

## Assignment

Build the complete Phase 1 vertical slice described in this packet. The result must run locally on an Apple Silicon M4 Mac mini and require no hosted database or public deployment.

Implement the specification as written. When an internal implementation detail is unspecified, choose the simplest deterministic option. Do not broaden scope.

## Required outcome

The operator must be able to run a fixture tournament from a fresh checkout and receive:

- immutable generation artifacts;
- CSS from at least two fixture contestants;
- one exact desktop screenshot per valid candidate;
- anonymous fixture-judge scores and critiques;
- emergent awards;
- an aggregated leaderboard;
- a static public gallery styled with the champion CSS; and
- a `1440 × 1200` screenshot of that completed gallery for sharing.

The same pipeline must accept real command-based contestant and judge harnesses through configuration without changing orchestration code.

## Implementation order

Follow this order. Keep the system runnable at the end of each numbered step.

### 1. Bootstrap the repository

- Pin Node.js 24 LTS.
- Initialise strict TypeScript and `pnpm`.
- Add Playwright Chromium, Handlebars, Zod, PostCSS, `postcss-value-parser`, Sharp, Vitest, and a small CLI argument parser.
- Add formatting and linting with minimal configuration.
- Add `pnpm verify`, `pnpm test`, and `pnpm garden` scripts.
- Commit the lockfile.

Do not add a front-end framework or database.

### 2. Implement schemas first

- Encode every Phase 1 config and artifact schema from `03-artifact-and-config-schemas.md` in Zod.
- Add unit tests for valid examples, unknown keys, missing fields, score limits, totals, ID formats, and path formats.
- Centralise schema version constants.

Do not write orchestration code that emits unvalidated JSON.

### 3. Build the Season 1 challenge

- Create the Handlebars template with the exact DOM hooks in `01-challenge-contract.md`.
- Write concise final page copy covering the masthead, introduction, central question, rules, leaderboard, awards, method, judge notes, and footer.
- Create six neutral checked-in seed thumbnails and render exactly as many seed entries as the configured two-to-six contestant roster contains.
- Add a small local font collection with clear licences and checked-in licence files.
- Add `starter.css` and a conservative `fallback.css`.
- Render seed data and verify valid semantic HTML.

Do not use client-side JavaScript.

### 4. Implement immutable generation creation

- Load and validate current configs.
- Refuse duplicate generation IDs.
- Copy config snapshots into the generation.
- Resolve the challenge against seed or previous-generation data.
- Hash inputs and resolved outputs.
- Create random anonymous candidate IDs using a cryptographically secure source.
- Write `manifest.json`, `snapshot.json`, and operator-only `anonymous-map.json` atomically.
- Make the canonical snapshot directory read-only after creation where practical on macOS.

Add an integration test proving all contestant snapshot copies have identical hashes.

### 5. Implement contestant adapters

Create a common interface with at least:

```ts
interface ContestantAdapter {
  run(input: ContestantRunInput): Promise<ContestantRunResult>;
}
```

Implement:

- `FixtureContestantAdapter`: copies a named fixture CSS file after a short deterministic delay.
- `CommandContestantAdapter`: spawns configured argv with `shell: false`, explicit working directory, environment allowlist, timeout, log capture, and graceful termination followed by forced termination if needed.

The command adapter must not interpolate arbitrary strings. Replace only complete allowlisted placeholder argv values.

Create a private writable workspace per contestant. Copy in only the resolved challenge, starter CSS, local assets, and prompt. Collect only the declared submission and usage file.

No retry after any terminal outcome.

### 6. Implement CSS validation

- Decode as UTF-8 and reject invalid encoding.
- Enforce the byte limit.
- Parse with PostCSS.
- Detect `@import` structurally.
- Inspect declaration values with `postcss-value-parser` for prohibited URLs and data URIs.
- Reject script-like schemes and paths outside challenge-owned font assets.
- Strip comments into `sanitised.css` without minifying or reordering declarations.
- Emit structured validation results.

Do not rely on regular expressions alone for CSS parsing.

### 7. Implement deterministic rendering

- Use Playwright's bundled Chromium.
- Start a loopback-only static server on an ephemeral port.
- Use one fresh browser context per candidate.
- Apply the exact browser settings in `challenge.yaml`.
- Disable JavaScript.
- Abort non-loopback network requests.
- Wait for local fonts.
- Execute post-render visibility and overflow checks.
- Capture exactly `1440 × 1200` PNG.
- Record Chromium and Playwright versions.
- Close every browser context even after failure.

Include at least three fixture styles: valid conventional, valid visually distinct, and invalid remote-resource CSS.

### 8. Build the anonymous contact sheet

- Use Sharp.
- Produce exactly `1600 × 900` PNG.
- Fit every screenshot inside equal cells without cropping.
- Label cells only with anonymous candidate ID and validation status.
- Randomise cell order per judge using a stored deterministic random seed.
- Ensure the broad design language remains visible at normal image-viewing size.

If there are more candidates than fit legibly, reduce label size and use additional rows. Do not create multiple contact sheets in Phase 1.

### 9. Implement judge adapters

Create a common interface with candidate-score and awards operations.

Implement:

- `FixtureJudgeAdapter`: emits deterministic scores, critiques, and awards based on fixture mapping.
- `CommandJudgeAdapter`: uses argv arrays, explicit environment allowlist, timeout, raw-output preservation, and Zod validation.

Build one prompt per judge-candidate assessment. Do not expose the anonymous mapping, contestant config, identity-bearing paths, or other judges' results.

After candidate assessment, build one awards prompt per judge.

Do not repair invalid judge JSON.

### 10. Implement aggregation

- Recalculate every total.
- Ignore invalid judgments rather than converting them to zero.
- Calculate combined, median, originality, disagreement, and completed-judge counts.
- Rank with the exact tie-break sequence in the judging protocol.
- Include failed contestants with `rank: null`.
- Resolve anonymous IDs to public identities only in the aggregator and gallery stages.
- Emit validated `leaderboard.json` atomically.

Add unit tests for ties, missing judges, invalid candidates, and deterministic ordering.

### 11. Build the static public gallery

- Render the same challenge template with current results.
- Link the champion CSS as `champion.css`.
- Fall back safely when no valid champion exists.
- Copy only public-safe artifacts.
- HTML-escape every critique, rationale, label, name, and model-generated string.
- Add a CSP denying scripts and remote resources.
- Ensure the page works with JavaScript disabled and network blocked.
- Ensure every candidate card shows rank or failure state, screenshot, scores, critique, and awards.
- Render the completed public page at `1440 × 1200` and save `gallery-screenshot.png`.

The gallery should inherit its visual layout from champion CSS; do not add a competing application stylesheet. A very small system-owned emergency stylesheet may appear only on explicit failure pages.

### 12. Implement resumability

- Persist the generation state after every completed task.
- Skip terminal successful and terminal failed tasks during resume.
- Retry only tasks that were never started or whose adapter can prove no request was accepted.
- Never modify a generation marked `completed`.
- Permit deterministic rebuilding of `public/` from completed source artifacts.

Simulate process termination in an integration test and verify resume does not rerun completed fixture contestants.

### 13. Operator documentation

Write a concise repository README explaining:

- prerequisites on Apple Silicon macOS;
- Playwright browser installation;
- fixture tournament command;
- real command adapter configuration;
- credential allowlisting;
- how to inspect a generation;
- how to open the gallery; and
- Phase 1 limitations.

Do not claim unsupported fairness or reproducibility guarantees.

## Suggested internal interfaces

Keep boundaries explicit:

```ts
interface ChallengeSnapshotBuilder
interface ContestantAdapter
interface SubmissionValidator
interface CandidateRenderer
interface ContactSheetBuilder
interface JudgeAdapter
interface ScoreAggregator
interface GalleryBuilder
interface GenerationRepository
```

Use dependency injection at construction time. Tests should use fixture adapters and temporary directories without monkey-patching global modules.

## Error-handling requirements

- A single contestant failure must not stop other contestants.
- A single candidate render failure must not stop judging valid candidates.
- A single judge failure must not stop other judges.
- If no candidate is valid, build a fallback gallery explaining the failure.
- If no judge succeeds, do not declare a champion; build a fallback gallery showing unranked candidates.
- Preserve raw logs privately but redact configured secrets.
- CLI exits non-zero only for an unrecoverable generation-level failure. Candidate-level failures are valid tournament outcomes.

## Logging

Human console logs should be concise:

```text
[0001] snapshot ready
[0001] contestant 2/4 complete: candidate-k7m4 (valid)
[0001] renders 3/4 complete
[0001] judge 1/3 complete
[0001] champion: Example Harness + Example Model — 82.67
[0001] gallery: generations/0001/public/index.html
```

Detailed stdout and stderr belong in generation logs. Never print credentials or entire prompts to the console.

## Phase 1 constraints the agent must not relax

- No mobile render
- No browser access for contestants
- No contestant retry or repair
- No competitor CSS sharing
- No separate high-resolution competitor images in contestant context
- No JavaScript in challenge or gallery
- No remote page resources
- No model call inside aggregation
- No mutable database
- No scheduler
- No public deployment
- No pairwise judging
- No visual-neighbour analysis

## Handoff result

The implementation agent should return:

- repository changes;
- exact fixture tournament command;
- exact test command and results;
- path to one completed fixture generation;
- path to the rendered static gallery;
- a short list of deliberately deferred items; and
- any specification conflict encountered rather than silently resolving it.
