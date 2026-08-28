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
pnpm garden verify
```

`verify` performs no model calls. It checks the runtime, configuration,
challenge assets, bundled Chromium, and executable paths for enabled command
adapters.

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
pnpm garden create-generation --season 001 --generations-root /tmp/local-maxima-runs
pnpm garden run-generation --season 001 --generations-root /tmp/local-maxima-runs
pnpm garden run-generation --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden resume-generation --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden build-gallery --generation 0001 --generations-root /tmp/local-maxima-runs
pnpm garden serve-gallery --generation 0001 --generations-root /tmp/local-maxima-runs
```

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
environment variable names. Keep provider credentials out of YAML. The
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
