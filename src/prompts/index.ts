export interface ContestantPromptPaths {
  readonly submissionPath: string;
  readonly challengePath: string;
  readonly starterCssPath: string;
}

/**
 * This text is intentionally kept as a literal: the packet makes its
 * generation-one contestant prompt a normative protocol artifact.
 */
export const CONTESTANT_GENERATION_ONE_PROMPT_TEMPLATE = String.raw`You are a contestant in Cascade League, a CSS-only design tournament.

Your identity in this tournament is a specific model-and-harness combination. You have one attempt to design the supplied page. You will not receive a screenshot or a second revision opportunity.

## Your task

Create exactly one file at:

__BACKTICK__[SUBMISSION_PATH]__BACKTICK__

The file must be named __BACKTICK__submission.css__BACKTICK__. Style the supplied HTML page using CSS alone.

Challenge HTML:

__BACKTICK__[CHALLENGE_PATH]__BACKTICK__

Optional structural starting reference:

__BACKTICK__[STARTER_CSS_PATH]__BACKTICK__

You may read both files. Do not modify the HTML or any challenge asset. Do not create JavaScript. Do not launch a browser, renderer, screenshot tool, preview server, or visual-inspection tool.

## Fixed judging environment

- Chromium
- Desktop viewport: 1280 × 1200 CSS pixels
- Device scale factor: 1
- JavaScript disabled
- Reduced-motion preference enabled
- Local challenge fonts only
- The submitted page is captured at its full document height, up to 12,000 pixels, while the 1280-pixel viewport width remains fixed

You may use the page vertically. Required sections and leaderboard entries do not need to fit within the first viewport, provided the complete page remains readable and intentional.

## Submission rules

- Output only valid CSS in __BACKTICK__submission.css__BACKTICK__.
- Maximum file size: 60 KiB.
- Do not use __BACKTICK__@import__BACKTICK__.
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

Originality is explicitly important and will be judged relative to the current cohort. Choose a coherent point of view; readability and intentionality still matter.

The jury will see your full-resolution screenshot, a lower-detail contact sheet of the cohort, and your CSS with comments removed. It will not know your model or harness identity.

Finish by ensuring __BACKTICK__[SUBMISSION_PATH]__BACKTICK__ exists. Do not attempt to run or inspect the result.
`;

function replacePath(template: string, marker: string, value: string): string {
  return template.replaceAll(marker, () => value);
}

export function buildContestantGenerationOnePrompt(
  paths: ContestantPromptPaths,
): string {
  return replacePath(
    replacePath(
      replacePath(
        CONTESTANT_GENERATION_ONE_PROMPT_TEMPLATE,
        "[SUBMISSION_PATH]",
        paths.submissionPath,
      ),
      "[CHALLENGE_PATH]",
      paths.challengePath,
    ),
    "[STARTER_CSS_PATH]",
    paths.starterCssPath,
  ).replaceAll("__BACKTICK__", String.fromCharCode(96));
}

export interface JudgeCandidatePromptMetadata {
  readonly generationId: string;
  readonly judgeId: string;
  readonly anonymousCandidateId: string;
}

const JUDGE_CANDIDATE_PROMPT_TEMPLATE = String.raw`You are an anonymous design judge for Cascade League, a CSS-only design tournament.

Evaluate one candidate page. You do not know which model or harness produced it. Do not infer or guess its identity.

You have received:

1. __BACKTICK__candidate.png__BACKTICK__: the candidate's full page at a fixed 1280 CSS-pixel viewport width, captured to its document height up to 12,000 pixels;
2. __BACKTICK__cohort.png__BACKTICK__: lower-detail anonymous thumbnails of every candidate, used only to assess relative originality; and
3. __BACKTICK__candidate.css__BACKTICK__: the candidate's CSS with comments removed.

The page explains the tournament, states its rules, and presents a leaderboard gallery. JavaScript, HTML changes, remote resources, and contestant-supplied assets are prohibited. Deterministic validation has already checked basic compliance; you should still judge how intelligently the candidate handles the constraint.

## Scoring

Score integers only.

### hierarchyAndReadability — 0 to 15

Can a viewer quickly understand the project, rules, leaderboard, and scores? Reward clarity without requiring conventional styling.

### composition — 0 to 15

Judge use of the full page, spacing, balance, rhythm, density, vertical pacing, and relationship between explanation and gallery. Do not penalise content merely for appearing below the first viewport.

### typography — 0 to 15

Judge font choice, scale, line length, contrast, rhythm, pairing, and appropriateness.

### colourAndVisualSystem — 0 to 10

Judge palette, contrast, repeated motifs, surfaces, borders, image treatment, and system consistency.

### coherenceAndCraft — 0 to 15

Judge whether alignments, components, details, restraint, and finish resolve into one intentional whole.

### originalityAndMemorability — 0 to 20

Compare the candidate with the cohort contact sheet. Reward a recognisable, coherent point of view and meaningful differentiation. Judge what is present, not whether it conforms to a preferred aesthetic. Do not confuse novelty with decoration.

### constraintAndCssCraft — 0 to 10

Judge whether the CSS uses the supplied semantic DOM intelligently, supports the design cleanly, and avoids unnecessary brittleness or complexity.

## Critique

Write a direct, specific free-form critique of two to four sentences and no more than 500 characters. It must identify what works and what most limits the design. End with an actionable next direction when practical. Do not mention or guess the contestant identity.

## Output

Return exactly one JSON object matching this shape, with no Markdown fences and no extra prose:

__BACKTICK____BACKTICK____BACKTICK__json
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
__BACKTICK____BACKTICK____BACKTICK__

Calculate __BACKTICK__totalScore__BACKTICK__ as the sum of the seven dimensions. Do not include decimals.
`;

export function buildJudgeCandidatePrompt(
  metadata: JudgeCandidatePromptMetadata,
): string {
  return JUDGE_CANDIDATE_PROMPT_TEMPLATE.replaceAll(
    "[GENERATION_ID]",
    () => metadata.generationId,
  )
    .replaceAll("[JUDGE_ID]", () => metadata.judgeId)
    .replaceAll("[ANONYMOUS_CANDIDATE_ID]", () => metadata.anonymousCandidateId)
    .replaceAll("__BACKTICK__", String.fromCharCode(96));
}

export interface JudgeAwardPromptSummary {
  readonly anonymousCandidateId: string;
  readonly totalScore: number;
  readonly originalityScore: number;
  readonly critique: string;
}

const JUDGE_AWARDS_PROMPT_TEMPLATE = String.raw`You have completed anonymous judging for one Cascade League generation.

Review the cohort contact sheet and your own score-and-critique summaries. Invent up to three short awards that recognise qualities genuinely present in this particular cohort. The categories should emerge from the work; do not use a predetermined taxonomy.

Good awards identify a meaningful distinction such as an unusual compositional strength, typographic voice, restraint, visual rhythm, or inventive use of the CSS-only constraint. Do not simply restate first, second, and third place.

Each award label must contain two to five words and no more than 50 characters. Each rationale must be one sentence and no more than 240 characters. You may return no awards if fewer than two valid candidates exist or nothing merits a distinct award.

Return exactly one JSON object with no Markdown fences and no extra prose:

__BACKTICK____BACKTICK____BACKTICK__json
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
__BACKTICK____BACKTICK____BACKTICK__

Use only anonymous candidate IDs from the supplied summaries.

Anonymous score-and-critique summaries:
[SUMMARIES]
`;

export function buildJudgeAwardsPrompt(input: {
  readonly generationId: string;
  readonly judgeId: string;
  readonly summaries: readonly JudgeAwardPromptSummary[];
}): string {
  const summaries = input.summaries
    .map(
      (summary) =>
        `- ${summary.anonymousCandidateId}: total ${String(summary.totalScore)}, originality ${String(summary.originalityScore)}. ${summary.critique}`,
    )
    .join("\n");
  return JUDGE_AWARDS_PROMPT_TEMPLATE.replaceAll(
    "[GENERATION_ID]",
    () => input.generationId,
  )
    .replaceAll("[JUDGE_ID]", () => input.judgeId)
    .replace("[SUMMARIES]", () => summaries)
    .replaceAll("__BACKTICK__", String.fromCharCode(96));
}
