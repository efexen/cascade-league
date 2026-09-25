# Local Maxima agent instructions

## Source of truth

The `local-maxima-planning/` packet is historical planning context, not current product authority. For new-season work, follow the explicit user request and the current runbook; preserve the engineering workflow, safety constraints, and verification requirements below. Do not broaden the requested scope.

If current requirements conflict or a requirement cannot be satisfied, stop and report the conflict explicitly rather than silently choosing a different contract. Historical packet wording does not override an explicit current user request.

## Engineering workflow

- Follow strict test-driven development for behavior: write one focused failing test, run it and confirm the expected failure, implement the smallest passing change, rerun it, then run the relevant suite.
- Keep the project runnable at the end of every numbered implementation step.
- Use the Node.js 24 LTS reference runtime (compatible Node.js >=22 is supported), strict TypeScript, pnpm, Playwright Chromium, Handlebars, Zod, PostCSS, postcss-value-parser, Sharp, and Vitest stack.
- Do not add React, Next.js, Astro, a database, Docker, a web framework, client-side JavaScript, remote page resources, or other Phase 1 non-goals.
- Never use paid model calls in tests. Fixture adapters must exercise the full pipeline deterministically and offline after dependencies/browser installation.
- Preserve immutable artifacts, anonymous judging boundaries, one-shot contestant behavior, argv-array command execution with `shell: false`, explicit environment allowlists, and model-output escaping.

### Runtime override

The user explicitly overrides the plan's exact-24 runtime requirement for the
working OS environment: compatible Node.js >=22 is supported when the project
works correctly there. Keep Node 24 as the reference in `.nvmrc`; package
metadata, `garden verify`, and documentation must not reject Node 22 or claim
that every future Node version has been tested. Do not weaken deterministic
dependency or browser pinning.

## Verification and handoff

Before declaring a wave complete:

1. Run formatting/linting/type checks and all tests implemented so far.
2. Run the applicable fixture command or integration path.
3. Inspect generated artifacts rather than merely asserting that commands exited successfully.
4. Report exact commands and actual outputs, deliberate deferrals, and any unresolved specification conflict.
5. Do not commit changes; the supervising agent owns Git commits and review checkpoints.

## Contestant and judge integration rules

- Every contestant added to a future season must use a real CLI coding agent with
  filesystem and tool access, such as Codex, OpenCode, or an equivalent agent.
  An HTTP model wrapper launched by a command is not a coding agent.
- Before readiness, audit the actual executable and wrapper paths and run an
  offline stub smoke test. Any separately approved paid live smoke call is a
  distinct gate; never make one implicitly during tests or verification.
- Choose judges separately from contestants. Never change a judge or otherwise
  retrospectively mutate an immutable run to match a later contestant setup.
