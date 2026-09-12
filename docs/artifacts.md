# Generation artifacts

A generation directory is the audit unit. Use the absolute path printed by `fixture-tournament`, `create-generation`, or `run-generation`.

## First checks

```sh
GENERATION=/ABSOLUTE/PATH/TO/GENERATION
python3 -m json.tool "$GENERATION/manifest.json" >/dev/null
python3 -m json.tool "$GENERATION/run-plan.json" >/dev/null
python3 -m json.tool "$GENERATION/leaderboard.json" >/dev/null
python3 -m json.tool "$GENERATION/run-summary.json" >/dev/null
open "$GENERATION/public/index.html"
open "$GENERATION/public/gallery-screenshot.png"
```

Normal completion writes `run-summary.json`. Regenerate that private derived file without a model call with:

```sh
pnpm garden summarize-generation --generation-path "$GENERATION"
```

Serve the public gallery on loopback with:

```sh
pnpm garden serve-gallery --generation-path "$GENERATION"
```

Open the printed URL and stop the server with Ctrl-C.

## What to inspect

- `manifest.json`: season/generation IDs, environment, roster, timestamps, errors, and terminal status. `completed` means the pipeline reached a terminal state; it does not mean every candidate or judge succeeded.
- `run-plan.json`: private write-once roster, maximum adapter-call counts, configured timeouts/token declarations, resource lanes, usage-reporting gaps, and one-shot acceptance.
- `config/` and `challenge/`: copied profile and immutable challenge snapshot used by this run. Existing runs do not read later profile edits. Before execution completes, however, the runner also rechecks the original repository challenge and prompt source files against stored hashes; keep that checkout present and byte-unchanged. Completed gallery rebuilds use the archived generation sources.
- `contestants/<id>/identity.json`, `run.json`, `validation.json`, `sanitised.css`, `screenshot.png`, and `screenshot-viewport.png`: configured identity, one attempt, validation outcome, judge-safe CSS, full-page render, and fixed-viewport render. Command runs may also have private `usage.json` and `execution-metadata.json`.
- `judging/`: operator-only anonymous map, judge-specific contact sheets/order, task state, validated judgments/awards, raw invalid output, usage/metadata, and logs.
- `leaderboard.json`: public identity projection, rank, score, judge completion, critique, awards, and failures.
- `run-summary.json`: private derived timing, usage/cost completeness, task counts, observed-version completeness, and resource-group observations.
- `public/`: shareable static output. It contains gallery HTML/CSS, neutral screenshots, design pages, fonts, metadata, and gallery screenshots—not the private audit files above.

`screenshot-viewport.png` uses the season's configured fixed viewport; `screenshot.png` is the full-page candidate capture. Current checked-in seasons use 1280 × 1200 for the viewport. The public gallery likewise includes `gallery-viewport.png` plus a separate full-page `gallery-screenshot.png`.

## Usage and identity caveats

`0` is a reported zero. `null` or `—` means unknown; an aggregate marked `partial` omits at least one unknown value and is not a complete bill. The bundled Codex and OpenCode wrappers do not report usage/cost. Their execution metadata records the observed CLI version and configured model identifier, not proof of the provider's backend checkpoint or entitlement.

Configured budget fields and plan call counts do not reconcile provider billing. Inspect the provider account separately and do not infer that missing cost is free.

## Private/public boundary

Treat the generation root as private. Do not publish:

- `judging/anonymous-map.json`;
- `run-plan.json` or `run-summary.json`;
- copied profiles/configuration;
- prompts or writable workspaces;
- `logs/`, raw model output, or error diagnostics;
- usage details, request IDs, or execution metadata; or
- raw competitor submissions outside the exporter's explicit sanitised public design pages.

Use [`export-static`](publishing.md) rather than copying the generation root. It applies the implemented allowlist and still does not grant publication rights.
