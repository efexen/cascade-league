# 03 — Artifact and Configuration Schemas

All YAML and JSON must be parsed and validated with Zod. Reject unknown keys in configuration and durable artifacts unless a schema explicitly marks an `extensions` object.

Use ISO 8601 UTC timestamps. Use SHA-256 lowercase hexadecimal hashes. Use POSIX-style relative paths in artifacts even on macOS.

## Identifier rules

- Season ID: four digits, for example `0001`.
- Generation ID: four digits, for example `0007`.
- Contestant ID: stable lowercase slug, for example `codex-gpt-5-6-high`.
- Judge ID: stable lowercase slug.
- Anonymous candidate ID: random, generation-specific label such as `candidate-k7m4`. It must not encode contestant identity or execution order.
- Task IDs: deterministic within a generation, built from generation, role, and anonymous ID.

Never use a public model name as an anonymous ID.

## `challenge/season-001/challenge.yaml`

```yaml
schemaVersion: 1
seasonId: "0001"
title: Local Maxima
challengeVersion: "1.0.0"
template: challenge.hbs
starterCss: starter.css
fallbackCss: fallback.css
seedData: seed/seed-generation.json
viewport:
  width: 1280
  height: 1200
  deviceScaleFactor: 1
browser:
  engine: chromium
  colorScheme: light
  reducedMotion: reduce
  locale: en-GB
  timezoneId: UTC
  javaScriptEnabled: false
submission:
  filename: submission.css
  maximumBytes: 61440
  allowImports: false
  allowRemoteUrls: false
  allowDataUrls: false
requiredSelectors:
  - "#masthead"
  - "#introduction"
  - "#rules"
  - "#leaderboard"
  - ".entry-card"
  - "#judge-notes"
```

`requiredSelectors` means those nodes must exist in the resolved HTML; it does not require the stylesheet to mention every selector.

## `config/contestants.yaml`

```yaml
schemaVersion: 1
defaults:
  timeoutMs: 480000
  maximumTotalTokens: 30000
  maximumSubmissionBytes: 61440
  concurrency: 4
contestants:
  - id: example-harness-example-model
    displayName: Example Harness + Example Model
    harness:
      name: example-harness
      version: "record-at-run-time"
      adapter: command
      command:
        argv:
          - /absolute/path/to/harness
          - run
          - --prompt
          - "{promptPath}"
          - --output
          - "{submissionPath}"
        environmentAllowlist:
          - EXAMPLE_API_KEY
    model:
      provider: example-provider
      name: example-model
      version: pinned-or-recorded
      reasoningEffort: medium
    budget:
      timeoutMs: 480000
      maximumTotalTokens: 30000
    enabled: true
```

### Command placeholder allowlist

Only these placeholders may occur as complete argv values:

- `{workspacePath}`
- `{challengePath}`
- `{starterCssPath}`
- `{promptPath}`
- `{submissionPath}`
- `{usageOutputPath}`

Do not support arbitrary string templating or shell fragments.

### Stable versus recorded identity

Contestant `id` remains stable within a season. Record exact model checkpoint, harness version, command version, reasoning configuration, and usage again in each run result. If a material version or configuration changes, create a new contestant ID or begin a new season.

## `config/judges.yaml`

```yaml
schemaVersion: 1
defaults:
  timeoutMs: 180000
  maximumOutputTokens: 4000
  concurrencyPerJudge: 2
judges:
  - id: example-judge
    displayName: Example Judge
    harness:
      name: example-harness
      adapter: command
      command:
        argv:
          - /absolute/path/to/judge-harness
          - run
          - --prompt
          - "{promptPath}"
          - --image
          - "{candidateScreenshotPath}"
          - --cohort
          - "{contactSheetPath}"
          - --output
          - "{judgmentPath}"
        environmentAllowlist:
          - EXAMPLE_API_KEY
    model:
      provider: example-provider
      name: example-vision-model
      version: pinned-or-recorded
    budget:
      timeoutMs: 180000
      maximumOutputTokens: 4000
    enabled: true
```

Additional allowed judge placeholders:

- `{candidateScreenshotPath}`
- `{contactSheetPath}`
- `{sanitisedCssPath}`
- `{judgmentPath}`

The awards task additionally supports `{judgmentSummaryPath}` and `{awardsPath}`.

## Generation directory

```text
generations/0001/
├── manifest.json
├── config/
│   ├── challenge.yaml
│   ├── contestants.yaml
│   └── judges.yaml
├── challenge/
│   ├── challenge.html
│   ├── starter.css
│   ├── fonts/
│   ├── thumbnails/
│   └── snapshot.json
├── contestants/
│   └── contestant-id/
│       ├── identity.json
│       ├── prompt.md
│       ├── run.json
│       ├── submission.css
│       ├── sanitised.css
│       ├── validation.json
│       └── screenshot.png
├── judging/
│   ├── anonymous-map.json
│   ├── judge-id/
│   │   ├── contact-sheet.png
│   │   ├── contact-sheet-order.json
│   │   ├── candidate-k7m4.json
│   │   └── awards.json
│   └── summary.json
├── leaderboard.json
├── public/
│   ├── index.html
│   ├── champion.css
│   ├── gallery-screenshot.png
│   ├── screenshots/
│   ├── fonts/
│   └── metadata.json
└── logs/
```

`anonymous-map.json` is operator-only. Do not copy it into `public/`.

## `manifest.json`

```json
{
  "schemaVersion": 1,
  "seasonId": "0001",
  "generationId": "0001",
  "status": "created",
  "createdAt": "2026-08-27T20:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "previousGenerationId": null,
  "challengeVersion": "1.0.0",
  "configHashes": {
    "challenge": "sha256-hex",
    "contestants": "sha256-hex",
    "judges": "sha256-hex"
  },
  "environment": {
    "os": "macOS",
    "architecture": "arm64",
    "nodeVersion": "24.x.x",
    "playwrightVersion": "exact-version",
    "chromiumVersion": "exact-version"
  },
  "contestantIds": ["example-harness-example-model"],
  "judgeIds": ["example-judge"],
  "errors": []
}
```

Store hashes as plain 64-character lowercase hexadecimal strings in the implementation. The example label `sha256-hex` is descriptive only.

## `snapshot.json`

```json
{
  "schemaVersion": 1,
  "sourceTemplate": "challenge/season-001/challenge.hbs",
  "dataSource": {
    "kind": "seed",
    "generationId": null,
    "path": "challenge/season-001/seed/seed-generation.json"
  },
  "resolvedHtmlPath": "challenge/challenge.html",
  "resolvedHtmlSha256": "64-lowercase-hex-characters",
  "assetHashes": {
    "thumbnails/seed-01.png": "64-lowercase-hex-characters"
  }
}
```

For generation two onward, `dataSource.kind` is `previous_generation` and `generationId` identifies it.

## `identity.json`

```json
{
  "schemaVersion": 1,
  "contestantId": "example-harness-example-model",
  "anonymousCandidateId": "candidate-k7m4",
  "displayName": "Example Harness + Example Model",
  "harness": {
    "name": "example-harness",
    "configuredVersion": "record-at-run-time"
  },
  "model": {
    "provider": "example-provider",
    "name": "example-model",
    "configuredVersion": "pinned-or-recorded",
    "reasoningEffort": "medium"
  }
}
```

## `run.json`

```json
{
  "schemaVersion": 1,
  "taskId": "0001-contestant-candidate-k7m4",
  "status": "succeeded",
  "startedAt": "2026-08-27T20:01:00.000Z",
  "completedAt": "2026-08-27T20:03:41.000Z",
  "durationMs": 161000,
  "exitCode": 0,
  "timedOut": false,
  "attemptCount": 1,
  "configuredBudget": {
    "timeoutMs": 480000,
    "maximumTotalTokens": 30000
  },
  "usage": {
    "inputTokens": null,
    "outputTokens": null,
    "reasoningTokens": null,
    "totalTokens": null,
    "estimatedCostUsd": null,
    "tokenLimitEnforced": false
  },
  "observedVersions": {
    "harness": "exact-if-known",
    "model": "exact-if-known"
  },
  "stdoutLog": "logs/contestant-candidate-k7m4.stdout.log",
  "stderrLog": "logs/contestant-candidate-k7m4.stderr.log",
  "error": null
}
```

Allowed run statuses:

- `pending`
- `running`
- `succeeded`
- `failed`
- `timeout`
- `missing_submission`
- `uncertain`

## `validation.json`

```json
{
  "schemaVersion": 1,
  "status": "valid",
  "submissionSha256": "64-lowercase-hex-characters",
  "submissionBytes": 18342,
  "staticChecks": [
    {
      "code": "css_parse",
      "status": "passed",
      "message": "CSS parsed successfully"
    }
  ],
  "renderChecks": [
    {
      "code": "document_loaded",
      "status": "passed",
      "message": "Challenge document loaded"
    }
  ],
  "errors": [],
  "warnings": []
}
```

Allowed validation statuses:

- `valid`
- `invalid`
- `render_failed`

Check status is `passed`, `warning`, `failed`, or `not_run`.

## Candidate judgment schema

Each judge writes one file per valid rendered candidate.

```json
{
  "schemaVersion": 1,
  "generationId": "0001",
  "judgeId": "example-judge",
  "anonymousCandidateId": "candidate-k7m4",
  "scores": {
    "hierarchyAndReadability": 13,
    "composition": 12,
    "typography": 12,
    "colourAndVisualSystem": 8,
    "coherenceAndCraft": 12,
    "originalityAndMemorability": 17,
    "constraintAndCssCraft": 8
  },
  "totalScore": 82,
  "critique": "A concise two-to-four sentence free-form critique under 500 characters.",
  "strongestQuality": "The editorial hierarchy is immediately legible.",
  "primaryWeakness": "Secondary metadata is visually too quiet.",
  "nextMove": "Increase contrast in the score and judge-note hierarchy without adding more decoration.",
  "confidence": "medium",
  "flags": [],
  "modelUsage": {
    "inputTokens": null,
    "outputTokens": null,
    "totalTokens": null,
    "estimatedCostUsd": null
  }
}
```

Score maxima are:

| Field | Maximum |
| --- | ---: |
| `hierarchyAndReadability` | 15 |
| `composition` | 15 |
| `typography` | 15 |
| `colourAndVisualSystem` | 10 |
| `coherenceAndCraft` | 15 |
| `originalityAndMemorability` | 20 |
| `constraintAndCssCraft` | 10 |
| **Total** | **100** |

The aggregator recalculates `totalScore` and rejects a mismatch.

`confidence` is `low`, `medium`, or `high`. `flags` may contain short machine-readable strings such as `content_obscured`, `derivative_visual_language`, or `css_overcomplicated`.

## Generation awards schema

After completing candidate judgments, each judge may create one to three awards.

```json
{
  "schemaVersion": 1,
  "generationId": "0001",
  "judgeId": "example-judge",
  "awards": [
    {
      "label": "Best Editorial Rhythm",
      "anonymousCandidateId": "candidate-k7m4",
      "rationale": "The page moves cleanly from manifesto to rules to gallery without feeling like a dashboard template."
    }
  ]
}
```

Rules:

- `label` is two to five words and no more than 50 characters.
- `rationale` is one sentence and no more than 240 characters.
- A judge may return zero awards if fewer than two valid candidates exist.
- Award labels are intentionally not normalised in Phase 1.
- A candidate may receive more than one award.

## `leaderboard.json`

```json
{
  "schemaVersion": 1,
  "seasonId": "0001",
  "generationId": "0001",
  "generatedAt": "2026-08-27T20:15:00.000Z",
  "rankingMethod": "mean-valid-judge-score-v1",
  "expectedJudgeCount": 3,
  "entries": [
    {
      "rank": 1,
      "contestantId": "example-harness-example-model",
      "displayName": "Example Harness + Example Model",
      "harnessName": "example-harness",
      "modelName": "example-model",
      "status": "valid",
      "screenshotPath": "contestants/example-harness-example-model/screenshot.png",
      "combinedScore": 82.67,
      "medianScore": 82,
      "originalityScore": 17.33,
      "completedJudgeCount": 3,
      "expectedJudgeCount": 3,
      "judgeScores": [
        {
          "judgeId": "example-judge",
          "totalScore": 82,
          "originalityScore": 17,
          "critique": "..."
        }
      ],
      "awards": [
        {
          "judgeId": "example-judge",
          "label": "Best Editorial Rhythm",
          "rationale": "..."
        }
      ],
      "failure": null
    }
  ]
}
```

Allowed leaderboard statuses:

- `valid`
- `invalid`
- `timeout`
- `render_failed`
- `judge_incomplete`
- `execution_failed`

## Future generation briefing schema

Do not implement in Phase 1, but reserve the contract so artifacts are compatible with the evolution phase.

```json
{
  "schemaVersion": 1,
  "seasonId": "0001",
  "generationId": "0002",
  "contestantId": "example-harness-example-model",
  "previous": {
    "generationId": "0001",
    "rank": 3,
    "combinedScore": 76.3,
    "originalityScore": 14.2,
    "cssPath": "previous/submission.css",
    "screenshotPath": "previous/screenshot.png",
    "critiques": [
      {
        "judgeDisplayName": "Example Judge",
        "totalScore": 75,
        "critique": "Short original judge critique."
      }
    ],
    "awards": []
  },
  "cohort": {
    "standings": [
      {
        "rank": 1,
        "displayName": "Another Harness + Model",
        "combinedScore": 84.1,
        "originalityScore": 18.0
      }
    ],
    "contactSheetPath": "cohort/contact-sheet.png"
  },
  "instructions": {
    "mayInspectCompetitorCss": false,
    "mayInspectFullCompetitorScreenshots": false,
    "mustProduceSingleCssSubmission": true
  }
}
```

The contact sheet must be the only image containing other contestants. Do not include separate competitor image files in the briefing workspace.

## Artifact immutability

- Completed generation artifacts are append-only.
- `resume-generation` may fill missing terminal artifacts but may not replace successful ones.
- Rebuilding `public/` is allowed because it is derived output. Candidate CSS, screenshots, judgments, scores, and manifests are not rebuildable after completion without creating a new generation.
- Any operator correction after completion requires a new generation or an explicit future administrative amendment record. Phase 1 does not implement amendments.
