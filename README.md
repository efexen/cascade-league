# Local Maxima

Local Maxima is a CSS-only design tournament. Phase 1 runs contestants once,
validates and renders their submissions, judges anonymous screenshots, produces
a deterministic leaderboard, and builds a static gallery. It has no database,
scheduler, client-side application, or hosted service.

## Prerequisites

On Apple Silicon macOS, use a native arm64 Node installation. The repository
reference is Node 24 LTS (`.nvmrc`), while compatible Node.js >=22 runtimes are
supported. The tests have been verified on Node 22.23 and Node 24.20; this is
not a guarantee for every future Node release. `garden verify` errors below
Node 22 and may report the actual/reference runtime when running another
supported version.

Install deterministically and install the pinned browser once:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm garden verify --profile fixture
```

`verify` performs no model calls. It checks the runtime, the selected
configuration profile, challenge assets, bundled Chromium, and executable paths
for enabled command adapters. It also checks, without executing any configured
command: the enabled roster size (two to six contestants and at least one
judge), that every allowlisted environment variable is present in the operator
environment, `$NAME`/`${NAME}` references inside argv values (an error when the
name is not allowlisted, a warning when it is, because argv runs with
`shell: false` and never expands them), placeholder compatibility of each
enabled command entry (contestants need `{promptPath}` and `{submissionPath}`;
judges need `{promptPath}` plus `{judgmentPath}` or `{awardsPath}`), pinned
non-generic `harness.version`/`model.version` values for enabled command
entries, and it warns when an enabled command contestant relies on prompt-only
one-shot enforcement.

## Configuration profiles

Run configuration lives in named profiles under `config/profiles/`:

```text
config/
  profiles/
    fixture/        checked in; deterministic offline roster
      contestants.yaml
      judges.yaml
    real.example/   checked in; placeholder template, no credentials
      contestants.yaml
      judges.yaml
    real.local/     git-ignored; the normal operator profile for real runs
      contestants.yaml
      judges.yaml
```

- Every general command that reads or creates a generation requires an
  explicit `--profile`; there is no silent default. Only
  `fixture-tournament` needs no flag because it always runs the checked-in
  `fixture` profile.
- A profile ID is a lowercase hyphenated slug, optionally dot-separated into
  more slug segments (`fixture`, `real.example`, `real.local`). Path
  separators, `.`/`..` traversal, symlinked profile directories or files, and
  missing YAML files are rejected before any configuration is read.
- `garden verify --profile real.example` intentionally reports
  `command_executable` errors because the template ships fake absolute
  executable paths; it must report no schema failures.
- For a real run, copy `config/profiles/real.example/` to
  `config/profiles/real.local/`, replace every placeholder, and pass
  `--profile real.local`. `real.local` is git-ignored; never commit
  credentials.
- Each generation copies the selected files verbatim into the canonical
  `config/contestants.yaml` and `config/judges.yaml` paths and writes
  `config/profile.json` (artifact `schemaVersion`, `profileId`, and
  repository-relative source paths). All three are hashed into
  `challenge/snapshot.json#inputHashes`. Completed generations always rebuild
  from their copied configuration, never from the currently selected profile.
- Run configuration is version tolerant: `schemaVersion: 1` (Phase 1) and
  `schemaVersion: 2` (adds `resourceGroups` and per-entry `execution`
  declarations) both parse into one internal shape. Archived v1 files are
  never mutated. At profile resolution every enabled command entry must declare
  `execution.resourceGroup` naming a group declared in the same file; fixture
  entries are exempt. v2 resource groups are validated and reported in the run
  plan in this phase. Contestant and judge calls now use immutable
  generation-config scheduling limits: a global concurrency cap, optional
  per-resource-group concurrency caps, strict FIFO admission (a blocked queue
  head is not overtaken), and minimum intervals between starts in each group.
  Judges remain sequential, and their candidate batches share group pacing.

## Planning a generation

Before creating a generation, preview and validate it without writing anything
or making a model call:

```sh
pnpm garden plan-generation --season 001 --profile fixture
```

`plan-generation` requires `--profile`, computes the next generation ID exactly
as `create-generation` would, runs the full `verify` preflight plus the same
season-continuity checks `create-generation` performs (so a plan failure
predicts a create failure), and prints the complete run plan: enabled
contestant and judge identities, whether external model calls are required, the
contestant / candidate-judging / awards call counts and their maximum total,
each entry's configured timeout and token ceilings, each resource group's
concurrency and start pacing, which entries cannot report usage/cost (their
argv lacks `{usageOutputPath}`), and which contestants rely on prompt-only
one-shot enforcement. It exits nonzero on any preflight error and writes
nothing.

`create-generation` persists this same validated plan as `run-plan.json` at the
generation root, hashes it into `challenge/snapshot.json#inputHashes` under the
`run-plan.json` key, and treats it as a private, write-once artifact: it is
never rebuilt, never mutated, and never copied into `public/`.

## Explicit external-model-call consent

Any generation whose copied configuration contains an enabled command
contestant or command judge may make external (potentially paid) model calls.
`run-generation`, `run-wave-b`, and `resume-generation` refuse such a generation
before they change any state unless you pass `--allow-model-calls`:

```sh
pnpm garden run-generation --generation 0001 --generations-root /tmp/local-maxima-runs --allow-model-calls
```

The refusal names the number and kind of pending calls (honestly labelled as
maximums when exact counts are not yet known) and never leaks secrets, prompts,
or executable paths. The grant is not persisted: a `resume-generation` that
still has pending command tasks must pass `--allow-model-calls` again, while a
resume whose command tasks are all terminal (for example, finishing scoring and
the gallery) proceeds without it. `create-generation`, `verify`,
`plan-generation`, `build-gallery`, `serve-gallery`, and `summarize-generation`
never require it and never make a model call themselves, and
`fixture-tournament` is fixture-only.

A command contestant whose `execution.oneShotEnforcement` is `prompt_only` is
not sandboxed against a second attempt. `plan-generation` refuses such a roster
unless you pass `--accept-prompt-only-one-shot`, which records the acceptance in
the plan.

## Offline fixture tournament

This is the complete, no-network, no-paid-provider smoke path:

```sh
pnpm garden fixture-tournament
```

The command creates a collision-safe temporary output root, runs three fixture
contestants and two deterministic fixture judges, and prints the absolute
generation, gallery, and private `run-summary.json` paths. To choose the
output location explicitly:

```sh
pnpm garden fixture-tournament --output-root /tmp/local-maxima-fixture-run
```

Repeated runs allocate another generation under that root rather than
overwriting a prior generation.

## Generation lifecycle

```sh
pnpm garden create-generation --season 001 --profile fixture --generations-root /tmp/local-maxima-runs
pnpm garden run-generation --season 001 --profile fixture --generations-root /tmp/local-maxima-runs
pnpm garden run-generation --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden resume-generation --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden build-gallery --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden serve-gallery --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden summarize-generation --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden summarize-generation --generation-path /tmp/local-maxima-runs/0001
```

`--profile` is required whenever a command creates a new generation
(`create-generation`, `run-generation --season`, `run-wave-b --season`) or
verifies the repository. Commands that act on an existing generation read the
generation's copied configuration instead.

Use `--generation-path /absolute/path/to/generation` instead of an ID and root
when inspecting an archived generation. `run-generation` can create a new
generation with `--season`, or advance an existing one. `resume-generation`
fills pending work and never retries terminal successful, failed, timed-out,
missing-submission, invalid, or uncertain tasks. A task recorded as running at
an interruption is uncertain unless an adapter can prove that no request was
accepted; it is not retried. Candidate and judge failures are valid tournament
outcomes. Only generation-level integrity or setup failures make the command
nonzero.

Completed generations are immutable. `run-generation` and `resume-generation`
refuse them. `build-gallery` is the narrow read-only exception for public
output: it may rebuild only derived `public/` bytes from a completed/scored
generation. `summarize-generation` is the corresponding private exception: it
may rebuild only the derived `run-summary.json`. The local server binds to
loopback; stop it with Ctrl-C.

## Run summary (`run-summary.json`)

Normal completion writes a private `run-summary.json` at the generation root
automatically: a successful `run-generation`, `resume-generation`, or
`fixture-tournament` ends with the summary present and prints its absolute
path. `summarize-generation` regenerates it later from the generation's copied
artifacts alone, for both location forms shown above. It requires no
`--profile` and no `--allow-model-calls`, never invokes a contestant or judge
adapter, and never executes a model command. Because the summary timestamp
comes from the durable `manifest.completedAt`, regeneration over unchanged
artifacts reproduces byte-identical output; integrity, identity, or generation
mismatches in the copied artifacts make the command exit nonzero with a single
bounded error line and leave the previous summary untouched.

Contents (all derived from durable generation artifacts, never from the live
repository profile): per-contestant duration, reported usage/cost, observed
version completeness, and one-shot enforcement mode; per-judge candidate and
awards call durations, usage, and cost; per-role planned/started/succeeded/
failed/timeout/missing-submission/invalid/uncertain task counts; wall-clock
start/completion/elapsed; aggregate token/cost totals; the configured maximum
call count from the durable `run-plan.json`; and per-resource-group configured
limits versus observed start counts, maximum concurrency, and minimum start
interval.

Known zero versus unknown: a `0` means a value was reported as zero; `null`
means no durable evidence exists, and `null` task counts mean no task-state
artifact for that role at all (for example archived Phase 1 generations, which
also report `null` plan-derived fields). Aggregate totals always carry a
`completeness` label: `"complete"` only when every relevant call reported the
value, `"partial"` when at least one relevant call was unknown (the summed
known parts still appear). `totals.callsWithUnknownUsage` and
`callsWithUnknownCost` count exactly how many attempted calls lacked those
fields.

Execution metadata and identity separation: each command or fixture call may
write a private `execution-metadata.json` beside its usage output. The
orchestrator archives accepted copies at
`contestants/<id>/execution-metadata.json` and
`judging/<judge>/execution-metadata/<candidate>.json` (plus
`awards.json`). These record what the harness _observed_ at run time
(`observedHarnessVersion`, `observedModelVersion`) plus a private
`providerRequestId`. Observed versions are deliberately separate from the
_configured_ identity stored in `identity.json`: `run.json#observedVersions`
and the summary's `versionCompleteness` derive only from observed metadata,
so a configured version is never reported as something that actually ran.
Missing, oversized, or invalid metadata keeps the observed identity unknown
without changing any terminal task status.

Privacy: provider request IDs, detailed usage, estimated costs, command
paths, prompts, environment variable names, credentials, logs, and judge
costs remain private. The summary itself is private, and neither it nor any
execution-metadata file is ever copied into `public/`; public output carries
only the existing allowlisted gallery bytes.

## Real command adapters

Command harnesses use an absolute executable and an argv array with
`shell: false`; arguments are never interpolated into a shell command. Every
placeholder must be a complete argv value from the relevant list.

Contestant placeholders:

```text
{workspacePath} {challengePath} {starterCssPath} {promptPath}
{submissionPath} {usageOutputPath} {executionMetadataOutputPath}
```

Judge placeholders:

```text
{workspacePath} {promptPath} {candidateScreenshotPath} {contactSheetPath}
{sanitisedCssPath} {judgmentPath} {usageOutputPath}
{judgmentSummaryPath} {awardsPath} {executionMetadataOutputPath}
```

For example, a command harness entry has `adapter: command`, an absolute
`command.argv`, and an `environmentAllowlist` containing only uppercase
environment variable names. Configure real harnesses in
`config/profiles/real.local/` (copied from the checked-in `real.example`
template). Keep provider credentials out of YAML. The
adapter copies only allowlisted variables into the child process and redacts
those values in private stdout/stderr logs. A wrapper may additionally write a
strict, bounded `execution-metadata.json` at `{executionMetadataOutputPath}`
recording the observed harness/model versions and a private provider request
ID; it is archived privately under the generation and never published. Never
put a secret, prompt, raw
model response, or usage/cost value in a public template or public metadata.

## Artifacts and inspection

Each generation contains immutable snapshots under `config/` and `challenge/`,
a private `run-plan.json`, per-contestant `identity.json`, `run.json`,
`validation.json`, and optional private `execution-metadata.json`, sanitised
CSS and screenshots, anonymous judge artifacts
under `judging/`, private logs under `logs/`, derived `leaderboard.json` and
`public/` output, and the derived private `run-summary.json`. The anonymous
map, raw judge output, prompts, workspaces,
usage, logs, and competitor CSS remain private. Public output contains only
`index.html`, `metadata.json`, `champion.css`, neutral filenames for
screenshots, local fonts, and `gallery-screenshot.png`.

Useful checks:

```sh
cat /absolute/path/to/generation/manifest.json
cat /absolute/path/to/generation/run-plan.json
cat /absolute/path/to/generation/run-summary.json
cat /absolute/path/to/generation/leaderboard.json
find /absolute/path/to/generation/public -type f -print
open /absolute/path/to/generation/public/index.html
open /absolute/path/to/generation/public/gallery-screenshot.png
```

The gallery is static HTML and CSS with JavaScript disabled, a restrictive CSP,
and no remote resources. The winning `submission.css` is copied byte-for-byte
to `public/champion.css`; when there is no eligible candidate with a valid
judge result, the exact challenge `fallback.css` is used and the page explains
why.

## First real-run gate and limits

Before a real run, review challenge copy and bundled-font licences, configure at
least two contestants, verify each timeout and credential allowlist, and run
`plan-generation` to see the exact roster, call counts, ceilings, resource
groups, and any usage/prompt-only caveats before spending. Then run a small
smoke generation with two contestants and one judge, granting
`--allow-model-calls` on the run commands. Treat that result as an operational
check, not a meaningful fairness or reproducibility claim.

Phase 1 deliberately defers scheduling, public deployment, databases, mobile
renders, iterative browser inspection, visual-neighbour analysis, pairwise
judging, human voting, and paid model calls in tests. The fixture path is the
supported deterministic acceptance path.
