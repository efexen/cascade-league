# Operator runbook

Run commands from the source repository root. Paths in capitals are values to
replace, not environment variables expanded by YAML. Do not copy commands from
historical plans without checking `pnpm garden <command> --help`.

## 1. Install on macOS

The reference environment is native Apple Silicon macOS with Node 24 LTS.
Node 22.x and Node 24 or newer are supported; Node 23 is excluded by the installed
test toolchain. Intel macOS and other platforms need their own validation. Do not
use Rosetta Node or system Chrome for reference screenshots.

1. Install Apple's Command Line Tools if Git is missing: `xcode-select --install`.
   Complete the installer before continuing.
2. Install native Node 24 using your preferred version manager or the official
   [Node distribution](https://nodejs.org/en/download). With an already installed
   `nvm`, run `nvm install` and `nvm use` in the checkout to read `.nvmrc`.
3. Check the actual runtime, then bootstrap:

```sh
node --version
node -p 'process.platform + " " + process.arch'
corepack enable
corepack prepare pnpm@10.30.3 --activate
pnpm --version
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm garden verify --profile fixture
```

Expect `darwin arm64` on Apple Silicon, and pnpm `10.30.3` from
`package.json#packageManager`. If Corepack is missing, install that exact pnpm
version with `npm install --global pnpm@10.30.3` instead of the two Corepack steps.
Use a user-owned Node installation; do not solve permissions by running project
commands with sudo. Playwright `1.63.0` and other dependencies are pinned by the
manifest/lockfile; `pnpm exec playwright install chromium` installs its browser,
not whichever Chrome happens to be on the machine. Do not regenerate the lockfile
or visual references just to make setup pass.

Installation downloads packages and Chromium. Once installed, the fixture path
needs no network or provider credentials. Run `pnpm garden fixture-tournament`
and inspect the printed paths as described in the [README](README.md).

## 2. Define participants before creating anything

Profiles live at `config/profiles/<profile>/contestants.yaml` and `judges.yaml`.
Use [participant setup](docs/participants.md) for the complete Codex example or
copy the generic `config/profiles/real.example/` template. Never overwrite an
existing `real.local/` profile; it may hold another run's private configuration.

Use two to six enabled contestants and at least one enabled judge. Start with two
contestants and one judge as an operational smoke check, not a benchmark claim.
Each entry describes harness + model + configuration + budget. Freeze the final
roster, order, challenge, judging protocol, and versions for a real season.

`real.local/` is explicitly git-ignored. Arbitrary names such as `my.local/` are
**not** automatically ignored. Keep secrets in the CLI's own credential store or
allowlisted environment, never YAML. No `.env` autoloading is implemented here.
A selected profile is snapshotted; editing it later does not change an existing run.

## 3. Plan, create, then cross the model-call boundary

The following assumes a configured `real.local` profile, the checked-in season
`001`, and a **fresh, dedicated** real-smoke root. `RUNS` is a shell variable used
in these commands only; it is not a YAML placeholder.

```sh
RUNS="$HOME/cascade-runs/real-smoke/season-001"
pnpm garden verify --profile real.local
pnpm garden plan-generation --season 001 --profile real.local \
  --generations-root "$RUNS" --accept-prompt-only-one-shot
```

These invoke no model and create no generation. Verify checks files, schemas,
Chromium availability, enabled rosters, executable `argv[0]`, environment variable
presence, required placeholders, declared resource groups, and non-generic version
labels. It does **not** run wrappers, validate provider login, resolve model
entitlement, or prove that a model label is a pinned backend checkpoint. If the
executable is `/usr/bin/env` or Node, check nested wrapper and CLI paths yourself.
Use `plan-generation --season ...` to validate the selected season; `verify` has
no `--season` option.

Review the plan's roster, call counts, timeouts, token declarations, resource
lanes, usage gaps, and prompt-only warnings. If acceptable, create the snapshot:

```sh
pnpm garden create-generation --season 001 --profile real.local \
  --generations-root "$RUNS" --accept-prompt-only-one-shot
```

Creation writes configs, a private immutable `run-plan.json`, challenge snapshots,
hashes, and identities. It makes no model calls. Read the printed generation path.
On a fresh root it is `$RUNS/0001`; use the actual printed ID otherwise.

Creation does not yet make the generation fully self-contained for execution.
Until the run completes, the original repository challenge and prompt source files
must remain present and byte-unchanged because execution rechecks them against the
stored hashes. Copied profile edits do not affect the generation. After completion,
gallery rebuilds use the archived generation sources.

**Potentially paid execution—run only with your own authorization and account:**

```sh
pnpm garden run-generation --generation 0001 --generations-root "$RUNS" \
  --allow-model-calls
```

Do not add `--season` when advancing an existing generation. Existing-generation
commands read copied configuration and do not need `--profile`.

The two safety flags mean different things:

- `--accept-prompt-only-one-shot` on **plan and create** acknowledges that agent
  tools are not technically prevented from making another attempt or rendering.
  It is recorded in the plan. This does not authorize spending.
- `--allow-model-calls` on **run/resume** authorizes pending command-adapter tasks,
  even if your wrapper uses a subscription or local model. It is not persisted.
  Repeat it when resuming with pending command calls.

`run-generation --season ...` combines creation and execution but currently has
**no** `--accept-prompt-only-one-shot` option. Do not use that shortcut for the
Codex/OpenCode examples. The separate create/run sequence above is supported.
`run-wave-b` is an advanced partial pipeline; it does not produce the final scored
gallery by itself. Prefer `run-generation` for a complete cycle.

### Spending and fairness limitations

- Plan counts are adapter invocations, not a guaranteed count of underlying API
  requests. An agent may make several internal model/tool turns in one invocation.
- Timeouts and scheduler concurrency/start pacing are enforced locally. They are
  not provider-side cancellation guarantees or shared account-wide rate limits.
- `maximumTotalTokens` and `maximumOutputTokens` in YAML are **not universal
  provider token caps**. The bundled Codex/OpenCode wrappers do not pass these
  values as provider limits. The judge adapter also uses its configured output
  limit to bound collected file bytes, which is not a billed-token cap.
- There is no generation/season dollar ceiling, spend reservation, or automatic
  provider billing reconciliation. Use provider-side limits and a small roster.
- These wrappers do not report usage/cost. `null`, `—`, and `partial` mean unknown
  or incomplete, not free. Declaring `{usageOutputPath}` alone does not prove that
  a custom wrapper actually reports complete usage.
- A one-shot declaration, a version label, and preflight success are claims to
  inspect, not proofs of sandboxing, entitlement, or experimental equivalence.

### OpenRouter direct HTTP profile (season 004)

`config/profiles/season004.local/` is a private six-contestant/two-judge
profile for the bounded provider integration wave. It uses the direct OpenRouter
Chat Completions API adapters, with an `openrouter` resource lane limited to one
concurrent task and a two-second start interval. The OpenRouter contestants and
Gemini judge require `OPENROUTER_API_KEY` in the launching environment; the
profile contains only the variable name. See
[OpenRouter adapter and local key setup](integrations/openrouter/README.md).

Without an account, use the benign `offline-preflight-placeholder` value only
for `garden verify` and `plan-generation`. Those commands do not invoke provider
adapters or make HTTP calls. They cannot validate authentication, credits,
model entitlement, image support, or likely spend. Do not create a generation
or run a smoke request before Ville explicitly approves a quoted cap. No
OpenRouter account, key, credit, or model entitlement is assumed by this
profile. The planned count is 20 harness tasks; model-side request counts and
costs remain unknown.

## 4. Seasons versus generations

| Term             | Meaning in this implementation                                                             |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Profile          | Current input roster/commands under `config/profiles/`; copied at creation.                |
| Season           | Challenge source directory plus its four-digit `seasonId`; a frozen experimental contract. |
| Generation       | One immutable tournament snapshot and its results. IDs are four digits.                    |
| Generations root | Directory containing `0001/`, `0002/`, etc.; not automatically partitioned by season.      |

CLI season `001` maps to ID `0001` and `challenge/season-001/`. Checked-in
seasons `001`, `002`, `003`, and `004` exist. Passing `--season 005` does not create its
source files. The next generation ID is allocated across directories in the
chosen root. Generation `0002` requires completed `0001` in that same root,
with the same season and enabled contestant IDs **in the same order**.

For another generation in the same season, retain the root and frozen profile,
plan and create again, then run the newly printed generation. A changed roster
needs a new season, not a forced rewrite of an old manifest. A fresh root resets
generation numbering but does not invent a distinct public season identity.
Static export records a source-generation identity and refuses an occupied
season/generation key from another run without changing the site. Re-exporting
the same source is allowed. Intentional replacement requires
`export-static --replace-existing`; inspect the old/new `sha256:` identities in
the error or replacement output before granting it.

For a genuinely new season, choose an unused ID and, **before its first run**:

```sh
# Example only: ensure season-004 does not already exist.
test ! -e challenge/season-004 && cp -R challenge/season-001 challenge/season-004
```

Edit `challenge/season-004/challenge.yaml`: set `seasonId: "0004"` and a new
`challengeVersion`; review the copied `challenge.hbs`, seed JSON, starter/fallback
CSS, fonts, and notices. Keep schema-supported paths, hooks, viewport, and
local-resource constraints. Seed rows are selected to match the roster size;
retain sufficient seed assets. Select the reviewed profile and a fresh root:

```sh
pnpm garden plan-generation --season 004 --profile real.local \
  --generations-root "$HOME/cascade-runs/season-004" --accept-prompt-only-one-shot
```

Then use the same separate create/run sequence with that season and root.
There is no season-init command, roster editor, or automatic contract/version
migration. Keep these new source inputs under review and archive them with the run.

Later generations render the previous completed leaderboard and reduced-detail
thumbnails in the challenge; this is bounded recursion, not a full evolutionary
feedback harness. The individual previous CSS/screenshot briefing reserved in the
planning packet is not currently built. Do not claim it is.

## 5. Inspect, resume, rebuild

Use either `--generation 0001 --generations-root "$RUNS"` or the exact directory
form below, never both location forms together:

```sh
pnpm garden summarize-generation --generation-path /ABSOLUTE/GENERATION
pnpm garden serve-gallery --generation-path /ABSOLUTE/GENERATION
pnpm garden build-gallery --generation-path /ABSOLUTE/GENERATION
```

The summary is private and derived from archived evidence. Normal completion
already writes it. The server is loopback-only; Ctrl-C stops it. `build-gallery`
rebuilds derived public files without model calls; it may launch Chromium.

After interruption, inspect private task states before resuming:

```sh
pnpm garden resume-generation --generation-path /ABSOLUTE/INCOMPLETE/GENERATION \
  --allow-model-calls
```

Omit the grant only when no command tasks remain pending. Terminal successes,
failures, timeouts, invalid outputs, and uncertain attempts are not retried.
A task left running without proof that no request was accepted becomes uncertain.
Completed generations refuse run/resume. Never edit completed evidence to force a
retry; only derived gallery/summary rebuilding is allowed. A completed tournament
can contain failed candidates or judges, so inspect artifacts, not only exit code.

See [artifacts](docs/artifacts.md) and [publishing](docs/publishing.md) before sharing.

## Troubleshooting

| Symptom                                                   | Action                                                                                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm`/Corepack missing or wrong version                  | Use the bootstrap above; compare `pnpm --version` with `packageManager`.                                                                                                                 |
| Chromium executable missing                               | Run `pnpm exec playwright install chromium` with the current lockfile installed. Do not point to system Chrome.                                                                          |
| Native module/architecture error                          | Confirm `darwin arm64`, reinstall dependencies under native Node, preserve the lockfile.                                                                                                 |
| Profile required, missing YAML, or symlink rejected       | Pass a valid explicit profile; use regular files at the two exact profile paths.                                                                                                         |
| `real.example` fails verification                         | Expected: fake executables, absent example credential variables, generic versions; prompt-only warning. Replace all placeholders in a private copy.                                      |
| Missing allowlisted variable                              | Export only the necessary variable in the launching shell. No `.env` is loaded automatically. Do not paste secrets into logs/issues.                                                     |
| `$HOME` or `~` passed literally to wrapper                | YAML argv has no shell expansion. Use literal absolute paths. Curly-braced adapter placeholders must be whole arguments.                                                                 |
| Preflight passes, wrapper cannot launch                   | Check absolute Node, loader, wrapper, CLI path and pinned CLI `--version`; preflight checks only the first executable.                                                                   |
| `401`, quota, model unavailable, CLI version mismatch     | Check your CLI login and entitlement separately; keep it private. Do not retry the terminal tournament task. A newer CLI requires reviewed compatibility, not merely relabeling the pin. |
| Prompt-only refusal/unknown acceptance option             | Accept at plan/create, not `run-generation`; then run the existing snapshot.                                                                                                             |
| Previous generation missing/not completed/roster mismatch | Correct the root or complete pending work. Use a fresh root for smoke checks and a new season for roster changes. Never delete evidence to bypass continuity.                            |
| Candidate invalid or judge JSON invalid                   | Read private validation/logs. No automatic repair. Fix the harness before a new properly labelled run.                                                                                   |
| Gallery is not the expected screenshot size               | Read copied `config/challenge.yaml`; current seasons use 1280 × 1200, historical plans use 1440 × 1200. Public full-page images are distinct from judged viewport images.                |
| Export rejects unexpected files/symlinks                  | Use a separate content-only destination; see the publication allowlist. Do not disable the audit.                                                                                        |
| Git push denied                                           | Local export grants no remote rights. Check the remote is your own repository and your account has write permission.                                                                     |

### Offline Season 004 guidance pair

The `fixture-guidance` profile is an offline engine fixture for the controlled
Luna plain/guided pair. Both entries use the same fixture harness, Luna stub
label, high reasoning setting, challenge, and token/time budgets; only the
second entry receives `challenge/season-004/guidance/luna-design.md`. Guidance
is bounded Markdown data, snapshotted with its hash, and is never loaded as a
Hermes or OpenCode skill. To create and complete a fresh fixture generation:

```sh
pnpm garden create-generation --season 004 --profile fixture-guidance \
  --generations-root /tmp/cascade-season-004-guidance
pnpm garden run-generation --generation 0001 \
  --generations-root /tmp/cascade-season-004-guidance
```

The generated public metadata discloses the guidance label and full text only
after judging. Only the guided contestant's private workspace receives the
Markdown file; judging prompts and workspaces receive no guidance or identity
metadata. Rebuilding the gallery reads the archived generation copy.
