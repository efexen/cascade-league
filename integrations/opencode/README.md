# OpenCode CLI integration

Tested with OpenCode CLI `1.18.25`.

The generic command adapter invokes these wrappers with argv arrays and
`/usr/bin/env node --import <repo>/node_modules/tsx/dist/loader.mjs`:

Contestant template:

```text
/usr/bin/env node --import <repo>/node_modules/tsx/dist/loader.mjs <repo>/integrations/opencode/contestant.ts
  --opencode-path /opt/homebrew/bin/opencode
  --opencode-version 1.18.25
  --model provider/model
  [--variant high]
  --workspace-path {workspacePath}
  --challenge-path {challengePath}
  --starter-css-path {starterCssPath}
  --prompt-path {promptPath}
  --submission-path {submissionPath}
  --execution-metadata-path {executionMetadataOutputPath}
```

Judge template (the same argv supports both operations):

```text
/usr/bin/env node --import <repo>/node_modules/tsx/dist/loader.mjs <repo>/integrations/opencode/judge.ts
  --opencode-path /opt/homebrew/bin/opencode
  --opencode-version 1.18.25
  --model provider/model
  [--variant medium]
  --workspace-path {workspacePath}
  --prompt-path {promptPath}
  --candidate-screenshot-path {candidateScreenshotPath}
  --contact-sheet-path {contactSheetPath}
  --sanitised-css-path {sanitisedCssPath}
  --judgment-path {judgmentPath}
  --judgment-summary-path {judgmentSummaryPath}
  --awards-path {awardsPath}
  --execution-metadata-path {executionMetadataOutputPath}
```

The wrapper uses the documented `opencode run --format json` JSONL event stream.
The positional prompt is deliberately placed before every `--file` option because
OpenCode 1.18.x treats `--file` as an array and may otherwise consume a trailing
prompt as another attachment. Contestant runs attach the challenge and starter CSS
with `--file`; judge score runs attach candidate and cohort PNGs, while awards runs attach only the cohort
PNG. Score and award operations are inferred from the generic path aliases:
score has all three output aliases equal, while awards has `judgmentPath` and
`awardsPath` equal and a distinct `judgmentSummaryPath`.

Only `HOME` and `PATH` are forwarded inside the wrapper. `HOME` lets OpenCode
resolve the user's local auth/configuration; credential values are never copied
into the repository or printed. The executable must be absolute in the profile.

The integration records one attempt, the observed CLI version, configured model,
and a null request ID. It does not retry. `prompt_only` remains an honest
configuration-level declaration: OpenCode's broad agent/tool capabilities cannot
be fully sandboxed by this thin wrapper, so the prompt and staged workspace are
the enforcement boundary. Usage/cost details are not available from this
wrapper's stable CLI output and remain unknown unless a future documented
OpenCode machine-readable usage field is adopted.
