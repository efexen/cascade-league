# 00 — Product Brief

## Product proposition

Local Maxima is a visible experiment in machine taste. Specific model-and-harness combinations repeatedly style the same semantic HTML page using CSS alone. A jury of models critiques and ranks the resulting designs. Over later generations, contestants receive feedback and standings and attempt to improve without collapsing into the same fashionable design language.

The public hook is not merely “which model writes the best CSS?” It is:

> When AI designers can see the shape of a population and learn from an AI jury, do they develop distinctive taste, converge on clichés, or learn to game the judges?

## Primary goals

1. Produce a visually compelling gallery after every generation.
2. Compare complete contestant systems: model, harness, configuration, and budget.
3. Preserve a strict CSS-only design constraint.
4. Make scoring and criticism inspectable rather than hiding a single composite number.
5. Encourage originality without allowing novelty to excuse poor usability.
6. Preserve complete run artifacts so results can later be published or analysed.
7. Keep the first implementation small enough to run manually and locally.

## Research questions

Phase 1 establishes infrastructure; later generations make the questions measurable.

- Do contestants improve after receiving critique?
- Do different model-and-harness combinations develop recognisable visual tendencies?
- Does the population converge on common AI design tropes?
- Which judges reward originality, readability, or polish differently?
- Do judges favour designs from their own model family?
- Does improvement on visible judges generalise to holdout judges or humans?
- Does additional harness sophistication improve design more than a stronger base model?

## Product principles

### The contestant is the whole system

The identity shown publicly must name both harness and model. `Codex CLI + GPT-5.6` and `Direct API + GPT-5.6` are separate contestants.

### Same generation, same challenge snapshot

All contestants in a generation receive byte-identical HTML and content assets. Comparison is invalid if one contestant sees different gallery data, copy, fonts, or images.

### One attempt means one attempt

Do not automatically repair, retry, or ask a contestant to fix invalid CSS. A timeout, missing file, invalid stylesheet, or render failure is part of the result.

### Transparent imperfection

Failed contestants and failed judges remain visible in generation metadata. Never silently exclude a poor run and rerun it until it looks good.

### Originality is a first-class quality

The jury rubric tells contestants that memorability and differentiation matter. Originality is not a hidden preference.

### The gallery is part of the experiment

The public page is not an administrative dashboard added afterward. It is the content every contestant styles and the main visual object shared publicly.

### Static first

Phase 1 produces static HTML, CSS, JSON, and PNG files. It needs no server database, authentication, scheduler, or client-side application.

## Core concepts

| Concept | Definition |
| --- | --- |
| Season | A series of generations using the same DOM contract, viewport, rubric, roster shape, and rendering policy. |
| Generation | One complete contestant, render, judge, rank, and gallery build cycle. |
| Contestant | A named model, harness, configuration, and budget combination. |
| Candidate | One contestant's CSS submission in one generation. |
| Judge | A model-and-harness combination that evaluates anonymous candidates. |
| Cohort | All valid and failed candidates in one generation. |
| Champion | The highest-ranked valid candidate in a generation. |
| Incumbent | A contestant's best candidate so far; introduced during the later evolution phase. |
| Award | A free-form distinction invented by a judge for a generation, such as “Best Editorial Rhythm.” |

## Primary user experiences

### Operator

The operator configures contestants and judges, starts a generation manually, watches concise progress, and opens the completed local gallery.

### Public viewer

The viewer sees:

- what the experiment is;
- the rules;
- the current generation number;
- a ranked gallery of designs;
- combined and individual judge scores;
- concise judge critiques;
- emergent awards; and
- contestant and harness identities.

### Future contestant briefing

From generation two onward, the contestant sees its own history in detail and the rest of the population only as a leaderboard and contact sheet. It should understand the cohort's broad visual direction without receiving enough detail to copy another design directly.

## Phase 0 scope

Phase 0 is complete when these are frozen:

- terminology;
- challenge page sections and DOM hooks;
- CSS constraints;
- desktop viewport;
- rendering policy;
- config and artifact schemas;
- judging rubric;
- anonymisation and ranking rules;
- Phase 1 acceptance criteria.

This packet constitutes the Phase 0 specification. An implementation may clarify internal details but must not silently change an externally observable contract.

## Phase 1 scope

Phase 1 includes:

- a semantic build-time HTML template;
- seed leaderboard content for generation 1;
- a command-driven contestant adapter;
- a command-driven judge adapter;
- fixture adapters requiring no model APIs;
- CSS validation and render isolation;
- one fixed desktop screenshot per candidate;
- anonymous pointwise judging;
- structured scores and a short free-form critique;
- free-form generation awards;
- score aggregation;
- a static gallery using the champion CSS;
- complete immutable artifacts; and
- a resumable local CLI.

## Explicit non-goals for Phase 1

- Scheduled or nightly execution
- Mobile or responsive scoring
- Allowing contestants to inspect screenshots
- Multiple attempts or repair loops
- Pairwise judging
- Holdout judges
- Human voting
- Visual embeddings or nearest-neighbour detection
- Automated critique synthesis
- Persistent database
- Public hosting
- Authentication
- Cross-browser comparison
- Animation judging
- Assets supplied by contestants
- Automatically changing the roster within a season

## Success criteria

Phase 1 succeeds when:

- a fresh checkout can run the fixture tournament on an Apple Silicon Mac;
- at least two real contestants can later be configured without changing orchestration code;
- every contestant receives the same challenge snapshot;
- no contestant can modify the canonical challenge;
- screenshots are reproducible enough for pixel comparison with a small tolerance;
- a malformed or timed-out contestant does not stop the generation;
- judges never receive public contestant identities;
- the gallery clearly exposes scores, critiques, failures, and awards;
- the generated page can be opened locally with no JavaScript and no remote resources; and
- one generation can be inspected entirely from its artifact directory.

## Public storytelling hooks

The implementation should retain data needed for later build-in-public posts:

- overall placement;
- score delta once multiple generations exist;
- judge disagreement;
- originality score;
- runtime and token/cost metadata when available;
- emergent awards;
- contact-sheet image;
- champion page screenshot; and
- contestant lineage.

Do not implement social posting in Phase 1. Preserve the raw ingredients.

