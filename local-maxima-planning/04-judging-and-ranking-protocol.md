# 04 — Judging and Ranking Protocol

## Purpose

The jury should reward a design that is readable, coherent, technically competent, and memorable. It should not reward novelty detached from usability, nor silently prefer familiar AI-generated aesthetics.

Phase 1 uses anonymous pointwise judging. Pairwise comparison, position reversal, holdout judges, score normalisation, and human voting are deferred.

## What a judge receives

For each candidate, a judge receives:

1. the fixed challenge description and rules;
2. the scoring rubric and anchors;
3. one full-height screenshot of the anonymous candidate, at the configured viewport width and capped at 12,000 pixels;
4. the anonymous cohort contact sheet made from fixed viewport previews;
5. the candidate CSS with comments removed; and
6. the required JSON response schema.

The judge must not receive:

- contestant display name;
- harness or model identity;
- provider identity;
- execution order;
- token usage, runtime, or cost;
- previous reputation or rank;
- filename or path containing contestant identity; or
- another judge's score.

## Why the contact sheet is included

Originality is relative to the current cohort. The full-resolution candidate screenshot shows craft; the contact sheet allows a judge to see whether the candidate is visually distinct without providing high-detail competitor designs.

All candidates appear at the same size. Contact-sheet order must be independently randomised for each judge, and that order must not match execution or eventual ranking order.

## CSS sanitisation

Before a judge sees CSS:

- remove all comments;
- normalise line endings to LF;
- retain actual declarations and selector order;
- do not minify;
- replace local filesystem roots with neutral relative paths; and
- verify the sanitised source hashes back to the original after comment removal and path normalisation.

CSS comments are excluded because they can leak identity or contain instructions aimed at the judge.

## Scoring rubric

### 1. Hierarchy and readability — 15 points

Assess whether the viewer can understand the project, rules, ranking, and key scores from what the design makes available in the full-height candidate screenshot. Consider readability, information access, first-viewport composition, and any content placed off-page, clipped, covered, or hidden. Judge those choices in context: deliberate experiments may be effective, while choices that make important information hard to access should lose clarity credit. Do not automatically assign zero because content is hidden or outside the viewport.

- `0–3`: Content is unreadable, obscured, or structurally confusing.
- `4–7`: Basic content is visible but hierarchy is weak or tiring.
- `8–11`: Clear and readable with minor hierarchy problems.
- `12–14`: Strong, deliberate information hierarchy.
- `15`: Exceptional clarity without sacrificing character.

### 2. Composition — 15 points

Assess use of the fixed-width desktop canvas across the full-height screenshot, spacing, balance, rhythm, density, first-viewport composition, and relationship between explanation and gallery. Consider clipped and off-page content in context; it can support an intentional composition, but may weaken access or balance.

- `0–3`: Broken or incoherent layout.
- `4–7`: Functional but poorly balanced or template-like.
- `8–11`: Competent composition with a few weak transitions.
- `12–14`: Deliberate, engaging composition throughout the viewport.
- `15`: Outstanding spatial design that makes the content feel inevitable.

### 3. Typography — 15 points

Assess font choice, scale, line length, contrast, rhythm, pairing, and appropriateness.

- `0–3`: Illegible or careless typography.
- `4–7`: Readable but generic, inconsistent, or poorly scaled.
- `8–11`: Solid typographic system.
- `12–14`: Highly considered and expressive typography.
- `15`: Typography is both exceptionally readable and central to the design identity.

### 4. Colour and visual system — 10 points

Assess palette, contrast, repeated motifs, surfaces, borders, imagery treatment, and consistency.

- `0–2`: Incoherent or inaccessible visual system.
- `3–5`: Usable but generic or inconsistent.
- `6–7`: Cohesive and appropriate.
- `8–9`: Distinctive, disciplined visual system.
- `10`: Exceptional control and purpose.

### 5. Coherence and craft — 15 points

Assess whether details resolve into one intentional whole: alignments, repeated components, finish, restraint, and visual polish.

- `0–3`: Appears broken or substantially unfinished.
- `4–7`: Uneven execution with obvious accidental details.
- `8–11`: Competent and mostly coherent.
- `12–14`: Highly polished with strong control.
- `15`: Exceptional finish where even small details reinforce the concept.

### 6. Originality and memorability — 20 points

Assess whether the design has a recognisable point of view and differs meaningfully from the cohort and common AI-generated UI patterns.

- `0–4`: Derivative, generic, or nearly indistinguishable from common templates.
- `5–9`: Some individual choices but dominated by familiar patterns.
- `10–14`: Clearly differentiated and memorable.
- `15–18`: Strong, coherent visual authorship and meaningful cohort differentiation.
- `19–20`: Surprising and highly memorable without sacrificing usability.

Originality does not mean maximal decoration. A restrained design can score highly when its typography, composition, proportions, or concept are distinctive.

The following do not automatically lose points, but should not receive originality credit merely for existing:

- dark mode;
- purple or blue gradients;
- glass effects;
- glowing borders;
- rounded cards;
- oversized sans-serif headings;
- monospace metadata;
- editorial serif typography;
- brutalist borders; or
- retro terminal styling.

Credit intent and execution, not the presence of a trend.

### 7. Constraint and CSS craft — 10 points

Assess whether the stylesheet handles the supplied semantic DOM intelligently and achieves its result cleanly within the rules.

- `0–2`: Obvious attempts to obscure required content or misuse CSS.
- `3–5`: Valid but brittle, excessively repetitive, or poorly structured.
- `6–7`: Sensible use of CSS and supplied hooks.
- `8–9`: Strong technical craft supporting the design concept.
- `10`: Elegant and inventive CSS with no unnecessary complexity.

This category is not a minification contest. Fewer declarations are not inherently better.

## Required critique

Every valid judgment includes one short free-form critique:

- two to four sentences;
- no more than 500 characters;
- written directly and specifically;
- names both what works and what most limits the design;
- ends with an actionable next direction when practical; and
- does not mention or guess contestant identity.

The structured `strongestQuality`, `primaryWeakness`, and `nextMove` fields must be consistent with the critique but may use shorter wording.

These critiques are displayed publicly and, in the evolution phase, shared verbatim with the contestant.

## Pointwise judging procedure

For each judge:

1. create a judge-specific random ordering of candidates;
2. create a judge-specific random ordering of the contact-sheet cells;
3. assess each candidate independently in that order;
4. validate the JSON response;
5. do not repair invalid model output with another model call;
6. after all candidate calls, run one separate awards call; and
7. record exact judge model and harness metadata privately.

If a judge output is invalid JSON or violates score ranges, mark that judgment invalid. The rest of the jury continues.

## Awards procedure

After judging all valid candidates, the judge receives:

- the anonymous contact sheet;
- anonymous candidate IDs;
- its own score summaries and critiques; and
- the awards output schema.

It may create one to three categories that reflect qualities genuinely present in that generation. Examples are illustrative only:

- Best Editorial Rhythm
- Boldest Restraint
- Strongest Typographic Voice
- Most Unexpected Composition
- Best Use of the Constraint

Do not provide a fixed list in the actual awards prompt. The labels should emerge from the designs.

An award does not change the numeric leaderboard in Phase 1.

## Candidate eligibility

### Valid candidate

A candidate is rankable when:

- contestant execution succeeded;
- static CSS validation passed;
- render validation passed;
- screenshot exists; and
- at least one judge produced a valid judgment.

### Judge-incomplete candidate

If the candidate is visually valid but fewer than the expected number of judges completed, set status `judge_incomplete`. It remains rankable when at least one valid judgment exists, but the UI must show the completed and expected judge counts.

### Failed candidate

Invalid, timed-out, execution-failed, and render-failed candidates appear after all rankable candidates. They receive no fabricated score.

## Combined scores

For a candidate with valid judgments:

```text
combinedScore = arithmetic mean of valid totalScore values
medianScore = median of valid totalScore values
originalityScore = arithmetic mean of originalityAndMemorability values
```

Round displayed values to two decimal places. Retain full precision internally.

Do not impute missing judge scores. Do not treat missing judgments as zero because that punishes candidates for judge infrastructure failures.

## Ranking

Sort rankable candidates by:

1. higher `combinedScore`;
2. higher `medianScore`;
3. higher `originalityScore`;
4. higher mean `hierarchyAndReadability`;
5. lexicographically ascending stable contestant ID as the deterministic final tie-break.

Assign competition ranks `1, 2, 3...`. Because the final tie-break always resolves equality, Phase 1 produces no shared ranks.

Failed candidates have `rank: null` and sort after rankable entries by public display name.

## Judge disagreement

Record but do not yet incorporate:

- minimum total score;
- maximum total score;
- score range;
- standard deviation; and
- each judge's candidate rank.

Expose the raw individual scores on the public page. A large disagreement is interesting evidence, not noise to hide.

## Self-family judgments

Phase 1 includes every configured judgment in the official combined score. Still record whether judge and contestant share a model provider or model family when that can be determined.

Do not reveal this relationship to the judge. A future phase can calculate a neutral-jury score that excludes self-family judgments.

## Feedback for generation two

When the evolution phase is implemented, share with the contestant:

- its prior combined and dimension scores;
- its prior placement;
- every judge's short critique verbatim;
- its awards;
- its own prior full screenshot;
- its own prior CSS;
- the public standings; and
- one `1600 × 900` cohort contact sheet with high-level thumbnails.

Do not share:

- separate full-resolution competitor screenshots;
- competitor CSS;
- private judge reasoning;
- anonymous mapping metadata; or
- comments or hidden working files from other contestants.

The contestant briefing should restate the originality rubric and say that, when its approach resembles the cohort, a coherent radical pivot may be more valuable than a minor refinement.

## Later protocol changes that require a new version

Any of the following changes must increment the judging protocol version and normally begin a new season:

- rubric dimensions or weights;
- viewport or screenshot policy;
- aggregation formula;
- eligibility requirements;
- adding pairwise results to official ranking;
- changing judge anonymity; or
- combining human votes with AI scores.
