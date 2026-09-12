# Documentation release checklist

Use this checklist before describing a checkout as ready for public onboarding. It is not a publishing command.

- [ ] A project-level licence has been selected and a `LICENSE` file added. Until then, do not claim an open-source licence or redistribution rights.
- [ ] Bundled font and seed-asset notices have been reviewed for the intended distribution.
- [ ] Publication of the existing Git author/committer identity has been explicitly approved, or an authorized history rewrite has been completed and the rewritten history rescanned.
- [ ] Tracked provider/model identities in planning documents, tests, and operator docs have been reviewed and approved as intentional public disclosures.
- [ ] README clone URL, Node/pnpm/Playwright versions, profile paths, CLI flags, and integration versions match the release commit.
- [ ] `pnpm garden --help` and each documented subcommand help have been compared with operator docs.
- [ ] `pnpm garden verify --profile fixture` passes on the release macOS environment.
- [ ] `pnpm garden fixture-tournament --output-root <temporary-path>` completes without model credentials, and its manifest, leaderboard, screenshots, summary, and gallery have been inspected.
- [ ] Documentation examples contain no personal absolute paths, identities, credentials, real request IDs, or invented model identifiers.
- [ ] Real-run docs clearly separate no-model plan/create from `--allow-model-calls`, explain prompt-only one-shot limits, and avoid claiming provider-side token or dollar enforcement.
- [ ] Export has been tested only into a disposable content-only checkout; docs state that it does not commit, push, deploy, or grant upstream gallery permissions.
- [ ] `pnpm verify` passes, or the release notes identify an exact blocker without claiming completion.

## Contract divergences to review

The original `local-maxima-planning/` packet is historical design input, not current CLI documentation. Current checked-in seasons use a 1280 × 1200 candidate viewport even though the original packet specified 1440 × 1200. The current CLI also includes later planning, scheduling, summary, gallery projection, and static-export features, while the full per-contestant later-generation evolution briefing remains unimplemented. Do not silently describe the historical contract as current behavior.
