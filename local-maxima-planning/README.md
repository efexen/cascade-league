# Local Maxima — Phase 0/1 Implementation Packet

Status: implementation-ready draft  
Target environment: Apple Silicon M4 Mac mini, macOS  
Initial track: desktop, one-shot, local-only  
Working title: **Local Maxima**

## One-sentence description

Local Maxima is a recurring CSS design tournament in which each contestant is a specific model-and-harness combination. Every contestant receives the same immutable HTML snapshot and may submit only a CSS stylesheet. Anonymous model judges score the rendered designs, provide short critiques, and assign emergent awards; the winning design styles the public leaderboard page for that generation.

## Decisions already made

- Treat each `harness + model + configuration` combination as a distinct contestant.
- Begin with a one-shot track only. A contestant gets one execution attempt and no rendered preview or screenshot feedback.
- Use one desktop target, not desktop and mobile simultaneously.
- Standardize the judged viewport at `1440 × 1200` CSS pixels with device scale factor `1`.
- The challenge page is also the project explanation, rules page, current leaderboard, and screenshot gallery.
- Contestants may not modify HTML or use JavaScript.
- Contestants receive the scoring rubric, including the importance of originality.
- From generation two onward, the intended briefing contains the contestant's own previous CSS and full screenshot, its results and critiques, and only a cohort gallery contact sheet for other contestants. It never includes competitors' CSS or full-resolution competitor screenshots.
- Every judge returns structured scores plus a short free-form critique.
- Judges may create one to three free-form, emergent awards rather than selecting from a fixed taxonomy.
- Phase 0 and Phase 1 are the immediate scope. Automated scheduling, iterative browser inspection, mobile design, pairwise voting, public human voting, and advanced similarity analysis are later phases.

## Important interpretation of “one shot”

One shot means **one contestant execution with no visual feedback loop**. A harness may perform its ordinary internal reasoning and file operations during that execution, because the harness itself is part of the contestant. It must not:

- launch a browser;
- render or inspect the page;
- receive a screenshot;
- restart after seeing the result;
- make a second attempt after validation or judging.

A direct API harness may be a single model response. An agent harness may internally use several model turns or tools. Those differences are recorded and are part of what the tournament measures.

## The bounded-recursion rule

The challenge and the public gallery share one HTML template. To avoid a screenshot containing itself:

- Generation `N` contestant screenshots render the generation `N` candidate CSS against the **generation `N-1` leaderboard data**.
- Generation 1 uses system-owned seed gallery content.
- After judging generation `N`, the public generation `N` page is built with generation `N` results and the winning CSS.
- Candidate screenshots are immutable and are never re-rendered after judging.

The public page may therefore contain small thumbnails that themselves show the previous generation. This is intentional, bounded to one generation per render, and visually reinforces the evolutionary concept.

## Read these documents in order

1. [00-product-brief.md](00-product-brief.md) — purpose, scope, concepts, users, and success criteria.
2. [01-challenge-contract.md](01-challenge-contract.md) — exact page, DOM, CSS, rendering, and content contract.
3. [02-system-architecture.md](02-system-architecture.md) — modules, execution state machine, isolation, and local architecture.
4. [03-artifact-and-config-schemas.md](03-artifact-and-config-schemas.md) — authoritative configuration and artifact shapes.
5. [04-judging-and-ranking-protocol.md](04-judging-and-ranking-protocol.md) — rubric, anonymisation, scores, critiques, awards, and ranking.
6. [05-prompt-contracts.md](05-prompt-contracts.md) — exact prompt requirements for contestants and judges.
7. [06-phase-1-implementation-brief.md](06-phase-1-implementation-brief.md) — ordered implementation task for the first agent.
8. [07-acceptance-tests.md](07-acceptance-tests.md) — automated tests, manual verification, and definition of done.

## Phase 1 result

At the end of Phase 1, one command must be able to:

1. create an immutable generation;
2. run two or more one-shot contestants;
3. validate and render each submitted stylesheet;
4. ask one or more anonymous model judges for scores and critiques;
5. aggregate the leaderboard;
6. render a static public gallery using the winning stylesheet;
7. capture a standard desktop screenshot of that completed gallery; and
8. preserve every input and output needed to audit the result.

## Inputs still required from the operator

The framework must not hard-code these choices:

- contestant roster;
- contestant harness commands and credentials;
- judge roster and commands;
- token or cost controls supported by each harness;
- final public project name;
- whether the first real run contains two, four, or more contestants.

Phase 1 must include fixture contestants and a fixture judge so the entire system can be built and tested without paid model calls.
