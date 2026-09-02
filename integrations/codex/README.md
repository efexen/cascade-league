# Codex CLI integration

This is a thin argv/file bridge for Codex CLI `0.150.1`, tested on this host
with `/opt/homebrew/bin/codex --version` returning `codex-cli 0.150.1`. The
generic command adapters still own timeouts, logs, environment allowlists, and
the one-attempt boundary. The wrapper makes one `codex exec` call and does not
retry.

The checked-in profiles intentionally do not include this integration or a
`real.local` roster. Copy these argv arrays into the operator's ignored
`config/profiles/real.local/` files, replacing the uppercase placeholders with
literal values. The wrapper entrypoints are TypeScript, so the pinned local
`tsx` loader is used while `/usr/bin/env` resolves `node` through the allowlisted
`PATH`.

Contestant command:

```yaml
argv:
  - /usr/bin/env
  - node
  - --import
  - /ABSOLUTE/REPO/node_modules/tsx/dist/loader.mjs
  - /ABSOLUTE/REPO/integrations/codex/contestant.ts
  - --codex-path
  - /opt/homebrew/bin/codex
  - --codex-version
  - 0.150.1
  - --model
  - MODEL_ID
  - --reasoning-effort
  - high
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
```

Judge command (use this same array for score and awards operations):

```yaml
argv:
  - /usr/bin/env
  - node
  - --import
  - /ABSOLUTE/REPO/node_modules/tsx/dist/loader.mjs
  - /ABSOLUTE/REPO/integrations/codex/judge.ts
  - --codex-path
  - /opt/homebrew/bin/codex
  - --codex-version
  - 0.150.1
  - --model
  - MODEL_ID
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
```

The generic judge adapter aliases all three output paths to the judgment file
for score calls. For awards calls it aliases `judgmentPath` and `awardsPath`
to the awards output while `judgmentSummaryPath` remains distinct; the wrapper
uses that difference to select the operation. Scores attach `candidate.png` and
`cohort.png`; awards attach the cohort image and supply the staged summary.
Both operations pass a local JSON schema to `--output-schema` and copy the
JSON-only `--output-last-message` result to the requested adapter output. Core
schemas remain the final validation authority.

OAuth is expected to come from the user's Codex home, not an API key. The
normal profile can allowlist `HOME` and `PATH`; `CODEX_API_KEY` is neither
required nor passed to the Codex child. Usage is left unknown because this
wrapper does not rely on an unstable Codex usage-event format. Before a model
call, the wrapper runs `codex --version` and refuses a mismatch with the pinned
profile version. Private, bounded `execution-metadata.json` records that
observed Codex version, the invoked model, and a null provider request ID.

Contestants use `workspace-write` and receive explicit prompt instructions to
write exactly the requested `submission.css`. The wrapper also disables the
Codex `browser_use`, `browser_use_external`, and `computer_use` feature flags.
This is still `oneShotEnforcement: prompt_only`: shell/tool-based denial is not
claimed to be technically complete, so the profile must record that limitation.
