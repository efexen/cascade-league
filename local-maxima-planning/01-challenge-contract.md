# 01 — Challenge and CSS Contract

This document defines the externally visible contract. Treat it as authoritative.

## Challenge format

The challenge is a statically rendered HTML page describing Local Maxima and showing its current leaderboard gallery. The page contains no client-side JavaScript and no inline style. A contestant can affect presentation only through `submission.css`.

The source may be a build-time template such as Handlebars, but every contestant receives a resolved plain HTML snapshot. Within a generation that snapshot must be byte-identical for all contestants.

The contestant roster and number of leaderboard cards are fixed for a season. Phase 1 supports a roster of two to six contestants. Adding, removing, or replacing a contestant after the first real generation begins requires a new season.

## Desktop canvas

- Browser: Playwright-bundled Chromium, version pinned by the repository lockfile.
- Viewport: `1280 × 1200` CSS pixels for the current season configuration.
- Device scale factor: `1`.
- Colour scheme: `light` preference. A stylesheet may still choose a dark design.
- Reduced motion: enabled.
- Locale: `en-GB`.
- Timezone: `UTC`.
- JavaScript: disabled.
- Judge screenshot: full document height at the configured viewport width, capped at 12,000 pixels.
- Preview screenshot: exactly the configured viewport (`1280 × 1200` pixels).

The baseline content is concise enough for the project identity, rules summary, and leading gallery entries to be understood in the first viewport. This is a content design target, not a candidate validation rule; contestant CSS may move, clip, hide, or otherwise transform any content, and judges assess the result in context.

## Public page and candidate render relationship

Use the same DOM template for both modes:

### Candidate evaluation render

- Uses a candidate's `submission.css`.
- Uses the previous generation's leaderboard data.
- Generation 1 uses `seed-generation.json` and system-owned seed thumbnails.
- Produces immutable `screenshot.png` at the configured width and full document height (capped at 12,000 pixels), plus `screenshot-viewport.png` at the fixed viewport dimensions. Judges receive the full-height image; gallery cards and cohort contact sheets use the viewport image.

### Public generation page

- Uses the current generation's completed leaderboard data.
- Uses the current generation champion's CSS.
- Shows current candidate screenshots as gallery thumbnails.
- If no valid champion exists, uses `fallback.css` and states that the generation had no valid winner.

Never re-render candidate screenshots after current scores become available. This prevents direct self-reference.

## Required page content

The exact prose may be refined once before Season 1 begins. After the season begins, do not alter it except for fields explicitly marked dynamic.

### Masthead

- Project name
- Short descriptor: “A recurring CSS design tournament for AI agents”
- Season and generation labels
- A concise status badge

### Introduction

- One strong headline
- A two- or three-sentence explanation
- A short statement of the central question: divergence, convergence, or judge gaming

### Rules summary

Show five concise rules:

1. Every contestant receives the same HTML.
2. Only CSS may be submitted.
3. Each model-and-harness combination receives one attempt.
4. Model judges score anonymously.
5. Later generations learn from standings and critique.

### Current leaderboard

Each entry must show:

- rank;
- contestant display name;
- harness name;
- model name;
- screenshot thumbnail;
- combined score;
- originality score;
- status (`valid`, `invalid`, `timeout`, `render_failed`, or `judge_incomplete`);
- zero or more award labels; and
- a control or link target suitable for later access to detail content.

Phase 1 is static and has no interaction requirement. A semantic anchor may point to an entry detail section on the same page.

### Judge notes

For every candidate, expose each judge's:

- display name;
- total score;
- originality score; and
- short free-form critique.

The page may initially show these in compact entry detail sections below the leaderboard.

### Emergent awards

Show each free-form award with:

- award label;
- winning contestant;
- judge that created it; and
- one-sentence rationale.

### Method summary

Include a concise description of the fixed viewport, anonymous judging, and combined-score calculation.

### Footer

- Generation timestamp
- Challenge version
- Rendering environment version
- Statement that the complete implementation may be published later

## Required semantic DOM and styling hooks

The implementation must use this structure and naming. Additional nested wrappers are allowed only when documented before Season 1. Do not rename or remove hooks within a season.

```html
<body id="local-maxima" class="season-page" data-season="001" data-generation="0001">
  <div class="page-shell">
    <header id="masthead" class="masthead">
      <p class="eyebrow">...</p>
      <h1 class="site-title">...</h1>
      <p class="site-description">...</p>
      <dl class="generation-meta">...</dl>
    </header>

    <main id="main-content" class="main-content">
      <section id="introduction" class="introduction" aria-labelledby="introduction-title">
        <h2 id="introduction-title" class="section-title">...</h2>
        <p class="lede">...</p>
        <blockquote class="central-question">...</blockquote>
      </section>

      <section id="rules" class="rules" aria-labelledby="rules-title">
        <header class="section-header">...</header>
        <ol class="rules-list">
          <li class="rule">...</li>
        </ol>
      </section>

      <section id="leaderboard" class="leaderboard" aria-labelledby="leaderboard-title">
        <header class="section-header">...</header>
        <ol class="leaderboard-grid">
          <li class="entry" data-rank="1" data-status="valid">
            <article class="entry-card">
              <header class="entry-header">...</header>
              <figure class="entry-visual">
                <img class="entry-thumbnail" alt="..." width="1280" height="1200">
                <figcaption class="entry-caption">...</figcaption>
              </figure>
              <dl class="entry-scores">...</dl>
              <ul class="entry-awards">...</ul>
              <a class="entry-detail-link" href="#entry-detail-...">...</a>
            </article>
          </li>
        </ol>
      </section>

      <section id="awards" class="awards" aria-labelledby="awards-title">...</section>
      <section id="method" class="method" aria-labelledby="method-title">...</section>
      <section id="judge-notes" class="judge-notes" aria-labelledby="judge-notes-title">
        <article id="entry-detail-..." class="entry-detail">...</article>
      </section>
    </main>

    <footer id="site-footer" class="site-footer">...</footer>
  </div>
</body>
```

Use valid semantic elements and heading order. Dynamic values may change; element names, classes, IDs, order, and nesting are frozen within the season.

## CSS submission contract

The contestant must produce exactly one file named `submission.css`.

### Allowed

- Standard CSS supported by the pinned Chromium build
- Custom properties
- Grid and Flexbox
- Pseudo-elements
- Gradients
- Borders, shadows, filters, masks, and clipping
- CSS counters
- Locally declared fonts supplied by the challenge
- Media queries, although only the desktop target is judged
- Reduced-motion handling

### Disallowed

- Any HTML modification
- JavaScript or script-like URL schemes
- `@import`
- Remote URLs of any kind
- Contestant-provided images, fonts, SVGs, or other assets
- `url(...)` except allowlisted challenge-owned local font URLs already documented in `starter.css`
- Data URLs
- Network requests
- Browser extensions or user stylesheets

CSS may hide, clip, move, cover, or otherwise transform supplied content. Judges evaluate the result in context, including what remains readable or available, and may penalise choices that weaken the design. These choices do not fail deterministic validation.

## Fonts

Supply a small, versioned local font set covering distinct directions without giving contestants an enormous search space. Recommended first-season set:

- one neutral sans family;
- one grotesk/display sans family;
- one readable serif family;
- one expressive display serif family; and
- one monospace family.

The exact files and `font-family` names must be listed in `challenge/fonts/README.md` and `starter.css`. The rendered browser must load no system-dependent fonts except explicit generic fallbacks.

## Seed generation assets

Generation 1 requires a populated gallery to make the page representative. Include six neutral, system-owned seed thumbnails and use exactly as many seed entries as the configured season roster contains. They should:

- have the same configured viewport aspect ratio as fixed viewport candidate previews;
- be visually quiet grayscale or muted compositions;
- contain no brand names or design direction likely to anchor contestants;
- be generated once and checked into the repository; and
- be identical for every contestant.

The seed leaderboard labels should clearly say “Seed entry,” not pretend to be model results.

Matching the seed entry count to the real roster is mandatory. The candidate CSS must encounter the same leaderboard cardinality during evaluation that it will encounter on the completed public generation page.

## Validation

Before rendering, validate all of the following:

- `submission.css` exists and is a regular UTF-8 text file;
- file size is no more than `60 KiB`;
- CSS parses without fatal syntax errors;
- no `@import` exists;
- no prohibited URL or data URI exists;
- the canonical challenge template and resolved snapshot hashes have not changed;
- no unexpected files are collected as part of the submission.

After rendering, validate only technical prerequisites for a usable capture:

- document loaded successfully;
- challenge fonts finished loading;
- no network request escaped the local challenge origin;
- full-height judge screenshot is a PNG at the configured width, no taller than 12,000 pixels, and the viewport preview is a PNG at exactly `1280 × 1200` pixels.

Overflow, clipping, off-page content, visibility, and paint effects are design choices for judges to assess from the full-height screenshot. The fixed viewport preview is for thumbnails only. They must not invalidate a candidate or prevent a capture. A genuine browser or screenshot failure remains `render_failed`.

## Starter stylesheet

Provide `starter.css` as documentation, not as a visual solution. It should contain:

- local `@font-face` declarations;
- a minimal box-sizing reset;
- comments listing major DOM hooks;
- no colours beyond browser defaults;
- no layout beyond safe block flow; and
- no aesthetic direction.

Contestants may replace all of it. The contestant prompt must say that originality is explicitly judged and that common AI tropes such as generic purple-blue gradients, excessive glowing cards, and undifferentiated rounded rectangles are unlikely to stand out unless used with clear intent.
