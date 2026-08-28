# 05 — Prompt Contracts

These are normative prompt requirements. Store the final prompt text used for every task in the generation artifacts.

Prompts may include additional harness-specific mechanical instructions, but they must not alter the challenge, rubric, budget, or available context.

## Contestant prompt: generation 1

Use the following content as the common task prompt. Replace bracketed paths and metadata deterministically.

---

You are a contestant in Local Maxima, a CSS-only design tournament.

Your identity in this tournament is a specific model-and-harness combination. You have one attempt to design the supplied page. You will not receive a screenshot or a second revision opportunity.

## Your task

Create exactly one file at:

`[SUBMISSION_PATH]`

The file must be named `submission.css`. Style the supplied HTML page using CSS alone.

Challenge HTML:

`[CHALLENGE_PATH]`

Optional structural starting reference:

`[STARTER_CSS_PATH]`

You may read both files. Do not modify the HTML or any challenge asset. Do not create JavaScript. Do not launch a browser, renderer, screenshot tool, preview server, or visual-inspection tool.

## Fixed judging environment

- Chromium
- Desktop viewport: 1440 × 1200 CSS pixels
- Device scale factor: 1
- JavaScript disabled
- Reduced-motion preference enabled
- Local challenge fonts only
- The submitted page is captured exactly at the viewport, not as a full-page screenshot

The masthead, project explanation, rules, and leading leaderboard entries should be understandable within that canvas.

## Submission rules

- Output only valid CSS in `submission.css`.
- Maximum file size: 60 KiB.
- Do not use `@import`.
- Do not use remote URLs, data URLs, external fonts, external images, or contestant-provided assets.
- Do not hide, falsify, replace, or contradict supplied rules, contestant identities, scores, or judge content.
- CSS pseudo-elements and decorative generated content are allowed when they do not change the meaning of supplied content.
- Use only the supplied semantic HTML and styling hooks.
- Do not write an explanation instead of the file.

## What the jury values

The jury scores the rendered design out of 100:

- Hierarchy and readability: 15
- Composition: 15
- Typography: 15
- Colour and visual system: 10
- Coherence and craft: 15
- Originality and memorability: 20
- Constraint and CSS craft: 10

Originality is explicitly important. The goal is not to produce the safest plausible AI dashboard. Familiar choices such as purple-blue gradients, glowing glass cards, rounded rectangles, oversized sans-serif headings, monospace metadata, editorial serifs, brutalist borders, or terminal styling receive no originality credit merely for being present.

Choose a coherent point of view. A restrained design can be highly original through typography, proportions, composition, rhythm, or concept. A radical design still needs to be readable and intentional.

The jury will see your full-resolution screenshot, a lower-detail contact sheet of the cohort, and your CSS with comments removed. It will not know your model or harness identity.

Finish by ensuring `[SUBMISSION_PATH]` exists. Do not attempt to run or inspect the result.

---

## Contestant prompt invariants

All contestants in a generation must receive the same text except for mechanical file paths. Do not mention:

- other contestant identities;
- execution order;
- previous model reputations;
- judge identities;
- predicted winner;
- provider-specific encouragement; or
- hidden scoring preferences.

The challenge HTML and starter CSS must be byte-identical across contestant workspaces.

## Judge prompt: candidate scoring

The judge receives the screenshot and contact sheet as image inputs. The sanitised CSS may be embedded after the instructions or supplied as a text file.

---

You are an anonymous design judge for Local Maxima, a CSS-only design tournament.

Evaluate one candidate page. You do not know which model or harness produced it. Do not infer or guess its identity.

You have received:

1. `candidate.png`: the candidate at 1440 × 1200 CSS pixels;
2. `cohort.png`: lower-detail anonymous thumbnails of every candidate, used only to assess relative originality; and
3. `candidate.css`: the candidate's CSS with comments removed.

The page explains the tournament, states its rules, and presents a leaderboard gallery. JavaScript, HTML changes, remote resources, and contestant-supplied assets are prohibited. Deterministic validation has already checked basic compliance; you should still judge how intelligently the candidate handles the constraint.

## Scoring

Score integers only.

### hierarchyAndReadability — 0 to 15

Can a viewer quickly understand the project, rules, leaderboard, and scores? Reward clarity without requiring conventional styling.

### composition — 0 to 15

Judge use of the fixed canvas, spacing, balance, rhythm, density, and relationship between explanation and gallery.

### typography — 0 to 15

Judge font choice, scale, line length, contrast, rhythm, pairing, and appropriateness.

### colourAndVisualSystem — 0 to 10

Judge palette, contrast, repeated motifs, surfaces, borders, image treatment, and system consistency.

### coherenceAndCraft — 0 to 15

Judge whether alignments, components, details, restraint, and finish resolve into one intentional whole.

### originalityAndMemorability — 0 to 20

Compare the candidate with the cohort contact sheet and common AI-generated UI patterns. Reward a recognisable, coherent point of view. Do not confuse novelty with decoration. A minimal design can be highly original; a visually loud design can be derivative.

Do not award originality simply for dark mode, gradients, glass, glows, rounded cards, oversized sans headings, monospace metadata, editorial serifs, brutalist borders, or retro terminal treatment.

### constraintAndCssCraft — 0 to 10

Judge whether the CSS uses the supplied semantic DOM intelligently, supports the design cleanly, and avoids unnecessary brittleness or complexity.

## Critique

Write a direct, specific free-form critique of two to four sentences and no more than 500 characters. It must identify what works and what most limits the design. End with an actionable next direction when practical. Do not mention or guess the contestant identity.

## Output

Return exactly one JSON object matching this shape, with no Markdown fences and no extra prose:

```json
{
  "schemaVersion": 1,
  "generationId": "[GENERATION_ID]",
  "judgeId": "[JUDGE_ID]",
  "anonymousCandidateId": "[ANONYMOUS_CANDIDATE_ID]",
  "scores": {
    "hierarchyAndReadability": 0,
    "composition": 0,
    "typography": 0,
    "colourAndVisualSystem": 0,
    "coherenceAndCraft": 0,
    "originalityAndMemorability": 0,
    "constraintAndCssCraft": 0
  },
  "totalScore": 0,
  "critique": "",
  "strongestQuality": "",
  "primaryWeakness": "",
  "nextMove": "",
  "confidence": "low|medium|high",
  "flags": []
}
```

Calculate `totalScore` as the sum of the seven dimensions. Do not include decimals.

---

## Judge prompt: emergent awards

Run once per judge after that judge has completed all candidate assessments.

---

You have completed anonymous judging for one Local Maxima generation.

Review the cohort contact sheet and your own score-and-critique summaries. Invent up to three short awards that recognise qualities genuinely present in this particular cohort. The categories should emerge from the work; do not use a predetermined taxonomy.

Good awards identify a meaningful distinction such as an unusual compositional strength, typographic voice, restraint, visual rhythm, or inventive use of the CSS-only constraint. Do not simply restate first, second, and third place.

Each award label must contain two to five words and no more than 50 characters. Each rationale must be one sentence and no more than 240 characters. You may return no awards if fewer than two valid candidates exist or nothing merits a distinct award.

Return exactly one JSON object with no Markdown fences and no extra prose:

```json
{
  "schemaVersion": 1,
  "generationId": "[GENERATION_ID]",
  "judgeId": "[JUDGE_ID]",
  "awards": [
    {
      "label": "",
      "anonymousCandidateId": "",
      "rationale": ""
    }
  ]
}
```

Use only anonymous candidate IDs from the supplied summaries.

---

## Future prompt: generation two and later

This is a reserved contract, not Phase 1 work.

The generation-two contestant prompt should contain the same base challenge and rubric, followed by:

- prior rank and score breakdown;
- each judge's critique verbatim;
- prior awards;
- the contestant's own previous CSS;
- the contestant's own full-resolution previous screenshot;
- cohort standings; and
- one lower-detail cohort contact sheet.

It should include this guidance:

> Decide whether your design thesis still has room for a meaningful refinement or whether the cohort has converged around similar choices. If your visual language resembles several other entries, a coherent radical pivot may improve both quality and originality more than polishing the same local maximum. Do not change merely to be strange: preserve readability, intent, and craft.

Do not attach separate competitor screenshots or competitor CSS.

## Output validation policy

- A contestant response that does not produce `submission.css` fails.
- A judge response that contains Markdown fences, leading prose, invalid JSON, wrong IDs, missing fields, or out-of-range scores fails schema validation.
- The orchestrator may parse a JSON object from an adapter-owned output file. It may not ask the model to repair the response.
- The orchestrator recalculates totals and rejects mismatches.
- Preserve invalid raw outputs privately for diagnosis.

