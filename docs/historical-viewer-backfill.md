# Historical public design viewers

`garden backfill-viewers` adds the current design viewer to an already published
season. It reads the public `metadata.json`, gallery links, raw design pages, and
entry screenshots from a static-site checkout. It does not read or rewrite
immutable generation snapshots, and future exports continue to use the same
viewer renderer.

Run a preview first. Preview is the default and prints the complete changed-file
list without writing:

```sh
pnpm garden backfill-viewers \
  --site-path /absolute/path/to/cascade-league-seasons \
  --season 0003
```

After reviewing the output, `--write` applies the additive migration:

```sh
pnpm garden backfill-viewers \
  --site-path /absolute/path/to/cascade-league-seasons \
  --season 0003 \
  --write
```

The command checks season and generation IDs, strict public metadata, gallery
link and screenshot ordering, raw page and screenshot existence, unexpected
generation files, and symlink or hardlink use on files it reads or changes. It
stops before writing if any generation fails validation. It accepts existing
viewers only when their contents match the shared renderer, which makes a
successful migration repeatable. It changes only `designs/<id>/view.html` and
the existing gallery's exact `href` value from `index.html` to `view.html`.

Legacy public metadata has no combined score. These viewers show rank and
published status without displaying a score. Entries without a raw design page
do not receive a viewer and are omitted from viewer navigation. Their original
gallery card and fallback label remain intact.

The historical Season 0003 migration was exercised against a disposable copy of
the published checkout: preview and write each covered 8 generations and 29
viewers. Inspection found 37 allowed changes (29 viewer files and 8 gallery
indexes); all 29 raw design pages and all other existing files were byte
identical. A repeat write reported `No changes required.` The live checkout was
not modified.

`IMPLEMENTATION_COMPLETE`
