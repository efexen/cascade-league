# 07 — Acceptance Tests and Definition of Done

Phase 1 is not complete until every required automated test passes and the manual M4 checklist has been performed.

## Test policy

- Tests must not invoke paid models.
- Tests must not require internet access after dependencies and Playwright Chromium are installed.
- Use temporary directories for generation artifacts.
- Use fixture adapters for deterministic outcomes.
- Do not update screenshots automatically during a normal test run.
- Pin fixture image and font files.

## Unit tests

### Configuration

- Accept valid challenge, contestant, and judge config examples.
- Reject unknown keys.
- Reject duplicate contestant and judge IDs.
- Reject malformed IDs.
- Reject negative timeouts and invalid token limits.
- Reject shell command strings where argv arrays are required.
- Reject unrecognised command placeholders.
- Reject relative executable paths when the adapter requires an absolute executable.

### Schemas

- Accept every documented artifact example after descriptive placeholder values are replaced.
- Reject out-of-range dimension scores.
- Reject a total that differs from dimension sum.
- Reject critique longer than 500 characters.
- Reject awards with invalid label or rationale lengths.
- Reject an award referring to an unknown anonymous candidate.
- Reject non-UTC or malformed timestamps.

### CSS validation

- Accept valid CSS using local fonts, Grid, gradients, and pseudo-elements.
- Reject a file larger than 60 KiB.
- Reject invalid UTF-8.
- Reject fatal CSS syntax errors.
- Reject `@import` with unusual whitespace or quoting.
- Reject `url(https://...)`, `url(http://...)`, protocol-relative URLs, data URLs, `javascript:`, and file URLs.
- Reject escaped or mixed-case prohibited schemes.
- Allow only documented challenge-owned local font URLs.
- Remove comments while retaining declaration and selector order.
- Confirm validation never modifies `submission.css`.

### Aggregation

- Calculate mean and median correctly for odd and even judge counts.
- Calculate originality mean independently.
- Recalculate totals rather than trusting judge-provided totals.
- Ignore invalid judgments without substituting zero.
- Mark a valid candidate with missing judges as `judge_incomplete`.
- Put all rankable candidates before failed candidates.
- Apply every tie-break in documented order.
- Produce deterministic output for identical inputs and supplied timestamp.
- Never give an award numeric score value.

### Prompt construction

- Contestant prompts differ only in mechanical file paths.
- All contestants receive the same challenge hash.
- Judge prompts contain no contestant, provider, harness, model, or identity-bearing path.
- Judge prompts include the rubric and exact response schema.
- CSS comments do not appear in judge input.
- Awards prompts contain only anonymous IDs.
- Judge prompts ask for contextual assessment of readability, information access, first-viewport composition, and clipped or off-page content, without automatically zeroing unusual visibility choices.

## Integration tests

### Generation creation

Given a valid fixture config, when generation `0001` is created:

- the directory is created exactly once;
- config snapshots are copied;
- resolved challenge HTML is valid;
- hashes are recorded;
- anonymous candidate IDs are unique and non-identifying;
- seed data is used;
- a second create attempt refuses to overwrite it; and
- canonical snapshot content is byte-identical for all contestants.

### Successful fixture tournament

Use three fixture contestants:

1. a restrained editorial design;
2. a bright geometric design; and
3. a valid but deliberately generic dashboard design.

Use two deterministic fixture judges with deliberately different preferences.

The test must prove:

- all contestants run once;
- all submissions validate;
- all candidate judge screenshots are full document height at the configured width (capped at 12,000 pixels), and fixed viewport previews are exactly 1280 × 1200 pixels;
- each judge evaluates candidates in stored random order;
- every candidate has two valid critiques;
- every judge emits zero to three awards;
- the expected fixture champion wins;
- the gallery uses that candidate's exact CSS bytes as `champion.css`;
- the public page includes every contestant, judge score, critique, and award;
- the public page loads with JavaScript disabled and external network blocked; and
- `gallery-screenshot.png` exists at exactly the configured 1280 × 1200 viewport dimensions.

### Mixed-failure tournament

Use fixture contestants that produce:

- valid CSS;
- prohibited remote CSS;
- no submission;
- process failure;
- timeout; and
- render failure.

Verify:

- one failure does not stop other contestants;
- only rendered candidates are judged;
- failed candidates appear publicly with correct status and no fabricated score;
- a champion is selected from eligible candidates; and
- CLI returns success when the generation pipeline itself completes.

### Judge failure

Configure one valid judge and one judge returning invalid JSON.

Verify:

- valid judgments are preserved;
- invalid output is archived privately;
- candidates are `judge_incomplete`;
- ranking uses the valid judge only;
- expected and completed judge counts are visible; and
- the awards task is not run for the invalid judge unless its candidate set completed validly.

### No valid candidate

Verify the system:

- declares no champion;
- uses `fallback.css`;
- builds a public failure gallery;
- shows every contestant outcome; and
- does not invent scores or awards.

### No valid judge

Verify the system:

- declares no champion;
- leaves valid candidate screenshots visible;
- states that judging failed;
- uses `fallback.css`; and
- keeps every candidate unranked.

### Resume

Interrupt a fixture generation after one contestant and one render complete.

On resume:

- completed contestant and render tasks are not rerun;
- pending tasks run;
- terminal failures are not retried;
- generation reaches `completed`; and
- already-created artifact hashes remain unchanged.

### Public escaping

Provide fixture critique and award strings containing HTML tags, quotes, ampersands, template delimiters, and script text.

Verify they are rendered as text, not executable markup, and CSP blocks scripts.

### Browser network isolation

Use CSS and content fixtures that attempt external requests. Verify Playwright records and aborts them and the candidate is marked `render_failed`; overflow, hidden sections, clipping, and paint experiments must still produce full-height judge captures plus fixed viewport previews and remain judgeable.

## Visual fixture tests

Check in one reference screenshot produced by a simple deterministic fixture stylesheet.

On the supported M4/macOS environment:

- the full-height candidate capture and fixed viewport preview dimensions must match their documented bounds;
- a small pixel-difference threshold may account for documented font rasterisation variation;
- major layout differences fail; and
- browser, font, or Playwright upgrades require explicit reference review.

Do not use the reference screenshot to validate artistic quality. It validates rendering stability only.

## Manual M4 Mac mini checklist

Run from a clean repository state.

1. Confirm native arm64 Node.js 24 is active.
2. Run dependency installation using the committed lockfile.
3. Install the pinned Playwright Chromium build.
4. Run `pnpm garden verify`.
5. Disconnect or block general internet access after dependencies are present.
6. Run all automated tests.
7. Run the fixture generation.
8. Open the candidate screenshots at 100% and confirm they are visually complete.
9. Open the contact sheet and confirm broad design differences remain legible.
10. Serve the public gallery on localhost.
11. Confirm the page works with JavaScript disabled.
12. Confirm no remote network request occurs.
13. Confirm the champion CSS is byte-identical to the winning submission.
14. Confirm individual judge critiques and scores are visible.
15. Confirm emergent awards are visible and do not alter numeric rank.
16. Open `gallery-screenshot.png` and confirm it matches the completed public page.
17. Stop the server and confirm no orphan Chromium or harness process remains.

## Operator-readiness checklist

Before the first real model run:

- Replace or approve the working project name.
- Review final challenge prose.
- Review licences for every bundled font and seed asset.
- Configure at least two real contestants.
- Configure at least two judges if budget allows; one is acceptable for the first smoke test.
- Pin or record exact model versions where providers permit.
- Verify credential environment allowlists.
- Confirm per-harness timeout and token settings.
- Run `verify` without invoking models.
- Archive the fixture generation separately from real results.

## Definition of done

Phase 1 is done only when all statements are true:

- The repository builds on native Apple Silicon macOS.
- All automated tests pass.
- The full fixture generation completes with one command.
- Generation creation is immutable and collision-safe.
- Contestants receive identical challenge snapshots.
- Contestants cannot receive rendered feedback in the intended execution path.
- Invalid and failed candidates are preserved without stopping the tournament.
- Screenshots are deterministic, exact-size desktop images.
- Judges operate anonymously and emit schema-valid scores plus short critiques.
- Originality is scored out of 20 and explained to contestants and judges.
- Judges can create free-form awards that do not affect numeric ranking.
- Aggregation is deterministic and contains no model call.
- The champion CSS styles the current static gallery.
- The completed gallery has a shareable screenshot at the configured viewport dimensions.
- The public page contains rules, description, leaderboard, thumbnails, scores, critiques, awards, and methodology.
- The public page uses no JavaScript or remote resource.
- Resume never reruns a terminal contestant attempt.
- Documentation explains how to configure real harnesses safely.
- All Phase 1 non-goals remain unimplemented.

## Recommended first real-run gate

Do not immediately run a large roster. First run:

- two real contestants;
- one judge;
- generation data marked as a smoke test; and
- no public claim that the ranking is meaningful.

After verifying prompts, screenshots, anonymity, costs, and artifact completeness, begin the first real season with the intended roster and at least two judges.
