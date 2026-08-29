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
for enabled command adapters.

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
  never mutated. v2 resource groups are validated in this phase but not yet
  scheduled.

## Offline fixture tournament

This is the complete, no-network, no-paid-provider smoke path:

```sh
pnpm garden fixture-tournament
```

The command creates a collision-safe temporary output root, runs three fixture
contestants and two deterministic fixture judges, and prints the absolute
generation and gallery paths. To choose the output location explicitly:

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
refuse them. `build-gallery` is the narrow read-only exception: it may rebuild
only derived `public/` output from a completed/scored generation. The local
server binds to loopback; stop it with Ctrl-C.

## Real command adapters

Command harnesses use an absolute executable and an argv array with
`shell: false`; arguments are never interpolated into a shell command. Every
placeholder must be a complete argv value from the relevant list.

Contestant placeholders:

```text
{workspacePath} {challengePath} {starterCssPath} {promptPath}
{submissionPath} {usageOutputPath}
```

Judge placeholders:

```text
{workspacePath} {promptPath} {candidateScreenshotPath} {contactSheetPath}
{sanitisedCssPath} {judgmentPath} {usageOutputPath}
{judgmentSummaryPath} {awardsPath}
```

For example, a command harness entry has `adapter: command`, an absolute
`command.argv`, and an `environmentAllowlist` containing only uppercase
environment variable names. Configure real harnesses in
`config/profiles/real.local/` (copied from the checked-in `real.example`
template). Keep provider credentials out of YAML. The
adapter copies only allowlisted variables into the child process and redacts
those values in private stdout/stderr logs. Never put a secret, prompt, raw
model response, or usage/cost value in a public template or public metadata.

## Artifacts and inspection

Each generation contains immutable snapshots under `config/` and `challenge/`,
per-contestant `identity.json`, `run.json`, `validation.json`, sanitised CSS and
screenshots, anonymous judge artifacts under `judging/`, private logs under
`logs/`, and derived `leaderboard.json` and `public/` output. The anonymous map,
raw judge output, prompts, workspaces, usage, logs, and competitor CSS remain
private. Public output contains only `index.html`, `metadata.json`,
`champion.css`, neutral filenames for screenshots, local fonts, and
`gallery-screenshot.png`.

Useful checks:

```sh
cat /absolute/path/to/generation/manifest.json
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
least two contestants, verify each timeout and credential allowlist, and run a
small smoke generation with two contestants and one judge. Treat that result as
an operational check, not a meaningful fairness or reproducibility claim.

Phase 1 deliberately defers scheduling, public deployment, databases, mobile
renders, iterative browser inspection, visual-neighbour analysis, pairwise
judging, human voting, and paid model calls in tests. The fixture path is the
supported deterministic acceptance path.
