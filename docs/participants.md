# Configure contestants and judges

A participant is a complete model + harness + configuration + budget identity. Configure profiles before creating a generation; creation copies the selected profile into immutable run artifacts.

## Prepare a private profile

```sh
# From the Cascade League repository root
cp -R config/profiles/real.example config/profiles/real.local
command -v codex
codex --version
command -v opencode
opencode --version
pwd -P
```

`real.local` is git-ignored. Do not overwrite it if it already exists. The version commands do not invoke a model. Use the absolute paths and exact installed versions they print. The bundled wrappers currently target the CLI contracts documented in [the Codex integration](../integrations/codex/README.md) and [the OpenCode integration](../integrations/opencode/README.md); a different CLI version needs compatibility review.

Use only a model identifier that your own authenticated account is entitled to use. Obtain it from that CLI's account/configuration or provider documentation. The uppercase `YOUR_…` values below are placeholders, not model recommendations or known model IDs. Replace every one before preflight. Cascade League cannot discover or grant model entitlement, and a provider may treat a named model as a moving alias rather than an immutable checkpoint.

## Complete two-contestant example

This example uses the checked-in Codex and OpenCode wrappers. Paste it into `config/profiles/real.local/contestants.yaml`, then replace all `/ABSOLUTE/…` and `YOUR_…` values. `schemaVersion: 2` is required for the scheduling fields shown here.

```yaml
schemaVersion: 2
defaults:
  timeoutMs: 480000
  maximumTotalTokens: 30000
  maximumSubmissionBytes: 61440
  concurrency: 2
resourceGroups:
  account-lane:
    maximumConcurrency: 1
    minimumStartIntervalMs: 1000
contestants:
  - id: codex-contestant-one
    displayName: Codex CLI + your entitled model
    harness:
      name: codex-cli-wrapper
      version: "YOUR_INSTALLED_CODEX_VERSION"
      adapter: command
      command:
        argv:
          - /usr/bin/env
          - node
          - --import
          - /ABSOLUTE/REPOSITORY/node_modules/tsx/dist/loader.mjs
          - /ABSOLUTE/REPOSITORY/integrations/codex/contestant.ts
          - --codex-path
          - /ABSOLUTE/PATH/TO/codex
          - --codex-version
          - YOUR_INSTALLED_CODEX_VERSION
          - --model
          - YOUR_ENTITLED_CODEX_MODEL_ID
          - --reasoning-effort
          - medium
          - --workspace-path
          - "{workspacePath}"
          - --challenge-path
          - "{challengePath}"
          - --starter-css-path
          - "{starterCssPath}"
          - --prompt-path
          - "{promptPath}"
          - --submission-path
          - "{submissionPath}"
          - --execution-metadata-path
          - "{executionMetadataOutputPath}"
        environmentAllowlist:
          - HOME
          - PATH
          # Add CODEX_HOME here only if your Codex login uses it.
    model:
      provider: YOUR_PROVIDER_LABEL
      name: YOUR_ENTITLED_CODEX_MODEL_ID
      version: YOUR_RECORDED_MODEL_VERSION_OR_ID
      reasoningEffort: medium
    budget:
      timeoutMs: 480000
      maximumTotalTokens: 30000
    execution:
      resourceGroup: account-lane
      oneShotEnforcement: prompt_only
    enabled: true

  - id: opencode-contestant-two
    displayName: OpenCode CLI + your entitled model
    harness:
      name: opencode-cli-wrapper
      version: "YOUR_INSTALLED_OPENCODE_VERSION"
      adapter: command
      command:
        argv:
          - /usr/bin/env
          - node
          - --import
          - /ABSOLUTE/REPOSITORY/node_modules/tsx/dist/loader.mjs
          - /ABSOLUTE/REPOSITORY/integrations/opencode/contestant.ts
          - --opencode-path
          - /ABSOLUTE/PATH/TO/opencode
          - --opencode-version
          - YOUR_INSTALLED_OPENCODE_VERSION
          - --model
          - YOUR_ENTITLED_OPENCODE_MODEL_ID
          - --variant
          - medium
          - --workspace-path
          - "{workspacePath}"
          - --challenge-path
          - "{challengePath}"
          - --starter-css-path
          - "{starterCssPath}"
          - --prompt-path
          - "{promptPath}"
          - --submission-path
          - "{submissionPath}"
          - --execution-metadata-path
          - "{executionMetadataOutputPath}"
        environmentAllowlist:
          - HOME
          - PATH
    model:
      provider: YOUR_PROVIDER_LABEL
      name: YOUR_ENTITLED_OPENCODE_MODEL_ID
      version: YOUR_RECORDED_MODEL_VERSION_OR_ID
      reasoningEffort: medium
    budget:
      timeoutMs: 480000
      maximumTotalTokens: 30000
    execution:
      resourceGroup: account-lane
      oneShotEnforcement: prompt_only
    enabled: true
```

`id` values must be unique lowercase hyphenated slugs and stay stable within a season. Display names are public. Treat a changed harness, model, reasoning setting, material configuration, or budget as a new identity and normally a new season.

The Codex wrapper reads OAuth state from `HOME` or an explicitly allowlisted `CODEX_HOME`; it deliberately does not forward `CODEX_API_KEY`. The OpenCode wrapper forwards only `HOME` and `PATH` to its child and expects the user's existing OpenCode authentication/configuration. These wrappers are therefore for already authenticated CLIs, not raw API-key setup.

## Complete judge example

Paste this into `config/profiles/real.local/judges.yaml` and replace every placeholder. The same command handles candidate scoring and awards; all path placeholders are required by the wrapper. The shared `account-lane` declaration exactly matches the contestant file.

```yaml
schemaVersion: 2
defaults:
  timeoutMs: 180000
  maximumOutputTokens: 4000
  concurrencyPerJudge: 1
resourceGroups:
  account-lane:
    maximumConcurrency: 1
    minimumStartIntervalMs: 1000
judges:
  - id: codex-judge-one
    displayName: Codex judge + your entitled vision-capable model
    harness:
      name: codex-cli-wrapper
      version: "YOUR_INSTALLED_CODEX_VERSION"
      adapter: command
      command:
        argv:
          - /usr/bin/env
          - node
          - --import
          - /ABSOLUTE/REPOSITORY/node_modules/tsx/dist/loader.mjs
          - /ABSOLUTE/REPOSITORY/integrations/codex/judge.ts
          - --codex-path
          - /ABSOLUTE/PATH/TO/codex
          - --codex-version
          - YOUR_INSTALLED_CODEX_VERSION
          - --model
          - YOUR_ENTITLED_VISION_MODEL_ID
          - --reasoning-effort
          - medium
          - --workspace-path
          - "{workspacePath}"
          - --prompt-path
          - "{promptPath}"
          - --candidate-screenshot-path
          - "{candidateScreenshotPath}"
          - --contact-sheet-path
          - "{contactSheetPath}"
          - --sanitised-css-path
          - "{sanitisedCssPath}"
          - --judgment-path
          - "{judgmentPath}"
          - --judgment-summary-path
          - "{judgmentSummaryPath}"
          - --awards-path
          - "{awardsPath}"
          - --execution-metadata-path
          - "{executionMetadataOutputPath}"
        environmentAllowlist:
          - HOME
          - PATH
          # Add CODEX_HOME here only if your Codex login uses it.
    model:
      provider: YOUR_PROVIDER_LABEL
      name: YOUR_ENTITLED_VISION_MODEL_ID
      version: YOUR_RECORDED_MODEL_VERSION_OR_ID
      reasoningEffort: medium
    budget:
      timeoutMs: 180000
      maximumOutputTokens: 4000
    execution:
      resourceGroup: account-lane
      oneShotEnforcement: enforced
    enabled: true
```

For an OpenCode judge, retain the judge placeholders and replace the loader script and wrapper flags with those in [the OpenCode judge template](../integrations/opencode/README.md). The selected judge model must accept the PNG attachments used by that CLI.

## Schema and command rules

- Profiles contain exactly `contestants.yaml` and `judges.yaml` as regular, non-symlinked files under `config/profiles/<profile-id>/`. Profile IDs are lowercase hyphenated slugs, optionally dot-separated.
- Two to six contestants and at least one judge must be enabled. Arrays may include disabled entries, but contestant config still contains two to six total entries.
- Unknown YAML keys are rejected. All timeouts/token declarations are positive integers. Contestant concurrency is at most 4; judge concurrency is at most 2. Resource-group start intervals are 0–60000 ms.
- Every enabled command entry needs `execution.resourceGroup`, and that group must be declared in the same file. A group named in both files must have identical limits.
- `command.argv[0]` must be absolute. Commands run with `shell: false`; `~`, `$HOME`, `${NAME}`, pipes, substitutions, and embedded placeholders are not expanded. Use literal absolute paths.
- Adapter placeholders must each be a complete argv value. Contestants must include `{promptPath}` and `{submissionPath}`. Judges must include `{promptPath}` and an output alias; the bundled judge wrappers require all paths shown above.
- `environmentAllowlist` contains variable names, not values. The child receives only listed variables. No `.env` file is loaded.
- `model.reasoningEffort` records identity. A wrapper receives a reasoning/variant flag only if its argv explicitly includes one; keep the values consistent.
- `harness.version` and `model.version` must be non-generic. Record what you actually configured. This is metadata, not proof that a provider pinned an immutable checkpoint.

## No-model validation

```sh
pnpm garden verify --profile real.local
pnpm garden plan-generation --season 001 --profile real.local \
  --generations-root "$HOME/cascade-runs/season-001" \
  --accept-prompt-only-one-shot
```

Preflight checks schemas, enabled roster, first executable, environment presence, placeholders, versions, Chromium, challenge inputs, and resource groups. It does not execute wrappers, validate login, check model entitlement or image support, or inspect nested executable/script paths behind `/usr/bin/env`. Review those paths and your CLI authentication yourself before creation.

The plan shows maximum adapter-call counts, timeouts, token declarations, resource lanes, missing usage reporting, and prompt-only contestants. It writes no generation and makes no model call. Follow the separate create/run sequence in the [operator runbook](../RUNBOOK.md#3-plan-create-then-cross-the-model-call-boundary); do not grant model calls until the immutable plan is acceptable.
