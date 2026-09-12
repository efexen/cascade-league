# Export a generation to your own static site

`garden export-static` is a local, no-model exporter. It rebuilds one completed generation into a separate content-only directory, creates `seasons/<season-id>/<generation-id>/`, and regenerates root `catalog.json`, `index.html`, and `.nojekyll`.

It does **not** initialize Git, commit, push, open a pull request, configure hosting, or publish anywhere. Access to any maintainer or upstream gallery repository requires separate permission. Do not point the exporter at a checkout you cannot write to, and do not assume that access to the Cascade League source repository grants gallery publishing rights.

## Prepare your own content-only checkout

Use a repository owned by you or one where your account has explicit write permission. Clone it separately from both the Cascade League source and the immutable generations root:

```sh
git clone YOUR_STATIC_SITE_REPOSITORY_URL "$HOME/cascade-site"
cd "$HOME/cascade-site"
git status --short
```

The exporter audits the destination before changing it. Aside from `.git/`, the root may contain only `README.md`, `CNAME`, `.nojekyll`, `catalog.json`, `index.html`, the exporter's `seasons/` tree, and these exact ordinary notice names: `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `NOTICE`, `NOTICE.md`, and `NOTICE.txt`. Their bytes are preserved. Other root files, every unrecognised nested file or directory, symlinks, and hard-linked files are rejected. Use a dedicated content-only repository rather than weakening that audit.

## Export locally

Run this from the Cascade League source checkout and use the generation directory, not its `public/` subdirectory:

```sh
pnpm garden export-static \
  --generation-path /ABSOLUTE/PATH/TO/COMPLETED/GENERATION \
  --site-path "$HOME/cascade-site"
```

Equivalent ID/root form:

```sh
pnpm garden export-static \
  --generation 0001 \
  --generations-root "$HOME/cascade-runs/season-001" \
  --site-path "$HOME/cascade-site"
```

Use one location form only. The source generation and site checkout must be separate and neither may contain the other. The manifest must have status `completed`. Each export records a `sha256:` source-generation identity derived from stable creation metadata and a cryptographically random nonce stored in the read-only challenge snapshot. The nonce is not published separately. Exporting the same unchanged source generation again is deterministic and may reuse its occupied season/generation directory.

By default, an occupied `seasons/<season>/<generation>/` with a different source identity is refused before any destination file is changed. The error prints the old and new identities. After verifying that both paths identify the intended runs, intentional replacement requires explicit consent:

```sh
pnpm garden export-static \
  --generation-path /ABSOLUTE/PATH/TO/COMPLETED/GENERATION \
  --site-path "$HOME/cascade-site" \
  --replace-existing
```

The replacement output prints both source identities. The flag grants replacement only for the selected export; it does not weaken the public-file allowlist or the symlink/hardlink checks.

The exported generation includes the public gallery, neutral screenshot names, local fonts, a page for each design, and each published design's sanitised CSS. It excludes private prompts, logs, run plans, run summaries, profile/config snapshots, anonymous mappings, raw judge output, provider request IDs, usage detail, and workspaces.

## Inspect before publishing

```sh
cd "$HOME/cascade-site"
git status --short
git diff --stat
git diff -- catalog.json index.html
git diff --check
open index.html
```

Also open the generated `seasons/0001/0001/index.html` and screenshots, using the actual IDs. Review public names, critiques, awards, operational labels, and metadata for information you are authorized to disclose.

Any later `git add`, commit, push, pull request, Pages setup, or deployment is a separate manual action governed by your repository's policy. The exporter never performs it. Upstream gallery publication is therefore out of scope unless a maintainer separately grants access and requests that workflow.
