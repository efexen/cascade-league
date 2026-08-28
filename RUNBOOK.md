# Phase 1 operator runbook

1. Install with `pnpm install --frozen-lockfile`, install Chromium with
   `pnpm exec playwright install chromium`, and run `pnpm garden verify`.
2. Run `pnpm garden fixture-tournament` and inspect the printed generation and
   gallery paths. Confirm `manifest.json` is `completed`, the leaderboard names
   the expected champion, and `public/champion.css` matches that contestant's
   `submission.css` byte-for-byte.
3. Open `public/index.html` or use `pnpm garden serve-gallery --generation-path
/absolute/path/to/generation`. The server prints a loopback URL; stop it
   with Ctrl-C and check that the process exits.
4. For a real smoke test, use two contestants and one judge. Inspect prompts,
   validation, exact-size screenshots, anonymous judge paths, scores, critiques,
   awards, private logs, and usage before increasing the roster.
5. If a run is interrupted, use `resume-generation` with the same generation
   path. Terminal tasks are preserved; ambiguous running tasks become
   `uncertain` and are not retried. Candidate/judge failures do not invalidate
   the generation.
6. Use `build-gallery` only to rebuild derived public output. Never edit a
   completed generation in place; make a new generation for an operator
   correction.

Do not publish `anonymous-map.json`, `logs/`, `raw/`, prompts, usage, private
workspaces, or competitor CSS. Do not infer artistic quality, fairness, or
general reproducibility from the deterministic fixture result.
