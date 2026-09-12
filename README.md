# Cascade League

Cascade League is a local CSS design tournament for model-and-harness combinations.
Each contestant gets the same frozen HTML page and one attempt to write CSS.
The runner validates the stylesheet, renders it in pinned Chromium, asks anonymous
judges for scores and critiques, and builds a static gallery with the winning CSS.
Failed attempts remain part of the result; there are no automatic repair calls.

The experiment compares whole systems, not just model names. A different harness,
model version, reasoning setting, or budget is a different contestant. The gallery
shows individual judge scores, originality, critiques, awards, and failures.
Everything needed for a private audit lives in files—no database, hosted service,
or client-side application is required.

**Start with fixtures.** They exercise the pipeline without an account, API key,
or model call. Real runs require your own installed CLI, authenticated account,
model entitlement, and explicit spending consent. Cloning this repository grants
neither provider access nor permission to publish to anyone else's gallery.

## macOS quickstart (no models)

Use native Apple Silicon Node.js 24 LTS, the reference in `.nvmrc`. Node.js 22.x
and 24 or newer are supported; Node 23 is excluded by the installed test toolchain.
This is not a promise that every future version has been tested.
Install Git and Node first; [the runbook](RUNBOOK.md#1-install-on-macos) includes
macOS setup and alternatives if Corepack is unavailable.

Run all `pnpm garden` commands from the repository root:

```sh
git clone https://github.com/efexen/cascade-league.git
cd cascade-league
corepack enable
corepack prepare pnpm@10.30.3 --activate
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm garden verify --profile fixture
pnpm garden fixture-tournament
```

Dependency and browser installation require network access. The fixture tournament
is offline afterward. It runs three fixture contestants and two fixture judges,
then prints absolute `generation`, `gallery`, and private `run-summary` paths.
The default output is a fresh temporary directory, not this checkout.

**Sandboxing and spend warnings.** `HOME` plus account configurations, MCP
servers, plugins, or local harness state may give a command harness access beyond
the per-contestant workspace. The argv environment allowlist narrows inherited
environment, and wrapper-specific safeguards vary; this is not a full sandbox. Timeouts, scheduler
concurrency, and declared token ceilings are local scheduling hints; they are
not a hard provider-side cancellation, quota reservation, dollar cap, or
billing reconciliation.

Open the printed gallery's `index.html`, or serve it on loopback:

```sh
pnpm garden serve-gallery --generation-path /ABSOLUTE/PRINTED/GENERATION
```

Replace that path with the printed **generation directory**, not `public/`.
Open the printed URL; Ctrl-C stops the server. Check `manifest.json` says
`completed`, inspect `leaderboard.json`, and open the screenshots. A completed
pipeline can contain failed candidates; fixture success is not proof of real
model authentication, artistic quality, or fairness.

To retain fixtures at a chosen location instead:

```sh
pnpm garden fixture-tournament --output-root "$HOME/cascade-fixture-demo"
```

Artifacts go under `cascade-fixture-demo/generations/0001/` on the first run.
Repeating the command creates the next generation, never overwrites the first.
Do not mix fixtures and a real roster in the same generations root.

## Run your own season

1. [Install and configure participants](RUNBOOK.md): use the complete
   [Codex example profile](docs/participants.md), or adapt an existing wrapper.
2. Preview with `plan-generation` (no writes or model calls).
3. Create an immutable snapshot with `create-generation`; explicitly accept
   prompt-only one-shot enforcement if applicable.
4. Run that existing generation with `run-generation --allow-model-calls`.
   This is the potentially paid boundary, separate from creation.
5. Inspect locally. Optionally [export into your own static-site repository](docs/publishing.md).

A **season** fixes the challenge and roster; a **generation** is one tournament
cycle within it. There is no `create-season` wizard. A fresh output root starts a
new run series, not a new challenge definition. See
[season and generation semantics](RUNBOOK.md#4-seasons-versus-generations) before
changing participants or selecting a new season number.

## Documentation and development

- [RUNBOOK.md](RUNBOOK.md): installation, safe command sequence, budgets, recovery.
- [Participant setup](docs/participants.md): complete editable examples, credentials,
  versions, argv placeholders, and configuration constraints.
- [Codex wrapper](integrations/codex/README.md) / [OpenCode wrapper](integrations/opencode/README.md).
- [Publishing](docs/publishing.md): local export, public/private boundary, own-repo deployment.
- [Artifacts](docs/artifacts.md): inspection and usage completeness.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
  [release checklist](docs/release-checklist.md).
- [Historical planning packet](local-maxima-planning/README.md): original Local Maxima
  design contracts, not a current installation guide. Known divergences are recorded
  in [the release checklist](docs/release-checklist.md#contract-divergences-to-review).

`pnpm garden verify --profile fixture` is a no-model preflight.
`pnpm verify` is different: it runs typechecking, lint, formatting, **all tests
including browser tests**, and fixture preflight. Tests must never call paid models.

## Status and limits

The CLI includes Phase 1 tournaments and later run controls, scheduling lanes,
private summaries, gallery projections, and local static export. It does not
provide automatic hosting, a season wizard, a total-dollar spending cap, complete
agent sandboxing, or the full per-contestant evolution briefing described in the
planning packet. Current checked-in challenges use a `1280 × 1200` judging viewport;
archived configurations may use `1440 × 1200`.

**Licensing is unresolved:** this checkout has no project-level LICENSE file.
Do not assume an open-source licence or redistribution permission from visibility
alone. Bundled fonts carry separate licence notices; see each season's
`fonts/README.md` and licence files. A maintainer must resolve project and asset
rights before an open-source release.
