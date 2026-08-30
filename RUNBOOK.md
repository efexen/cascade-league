# Phase 1 operator runbook

1. Install with `pnpm install --frozen-lockfile`, install Chromium with
   `pnpm exec playwright install chromium`, and run
   `pnpm garden verify --profile fixture`.
2. Run `pnpm garden fixture-tournament` and inspect the printed generation and
   gallery paths. Confirm `manifest.json` is `completed`, the leaderboard names
   the expected champion, and `public/champion.css` matches that contestant's
   `submission.css` byte-for-byte.
3. Open `public/index.html` or use `pnpm garden serve-gallery --generation-path
/absolute/path/to/generation`. The server prints a loopback URL; stop it
   with Ctrl-C and check that the process exits.
4. For a real run, copy `config/profiles/real.example/` to
   `config/profiles/real.local/` (git-ignored), replace every placeholder
   executable path and credential variable name, and confirm
   `pnpm garden verify --profile real.local` reports no issues. The checked-in
   `real.example` template deliberately reports `command_executable`,
   `environment_variable` (missing `EXAMPLE_API_KEY`/`SECOND_EXAMPLE_API_KEY`),
   and `version_genericity` errors plus a `one_shot_prompt_only` warning for its
   placeholders; anything beyond those known issues is a real defect.
   Generation-creating commands always require an explicit `--profile`;
   `fixture-tournament` is the only command with a fixed profile.
5. Run `pnpm garden plan-generation --season 001 --profile real.local` to see
   the exact roster, external-model-call requirement, call counts and maximum,
   per-entry ceilings, resource-group pacing, and any usage/cost or prompt-only
   caveats before spending. It writes nothing and makes no model call. If a
   command contestant is prompt-only, add `--accept-prompt-only-one-shot` to
   acknowledge the weaker one-shot guarantee.
6. For a real smoke test, use two contestants and one judge. Run commands that
   may call models require an explicit `--allow-model-calls` grant; the grant is
   never persisted, so a `resume-generation` with pending command tasks must
   repeat it. Inspect prompts, validation, exact-size screenshots, anonymous
   judge paths, scores, critiques, awards, private logs, and usage before
   increasing the roster.
7. If a run is interrupted, use `resume-generation` with the same generation
   path (and `--allow-model-calls` when command tasks are still pending).
   Terminal tasks are preserved; ambiguous running tasks become
   `uncertain` and are not retried. Candidate/judge failures do not invalidate
   the generation.
8. Use `build-gallery` only to rebuild derived public output. Never edit a
   completed generation in place; make a new generation for an operator
   correction. Completed generations rebuild from their copied
   `config/contestants.yaml`, `config/judges.yaml`, and `config/profile.json`,
   never from the currently selected profile. The private `run-plan.json` is
   hashed into the snapshot and is never rebuilt or published.

Do not publish `anonymous-map.json`, `logs/`, `raw/`, prompts, usage, private
workspaces, or competitor CSS. Do not infer artistic quality, fairness, or
general reproducibility from the deterministic fixture result.
