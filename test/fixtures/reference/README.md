# Gallery visual reference

`gallery-screenshot.png` is a checked-in rendering reference for the fixed
fixture tournament at `1440×1200`. The test ignores per-channel changes of up
to eight levels, permits at most `0.5%` changed pixels, and rejects any channel
delta above 32. This small allowance covers native M4/macOS font rasterisation
variation; it is not an artistic-quality score.

Browser, font, Playwright, template, or stylesheet upgrades require an
explicit human review of the reference before replacing it. The test never
auto-updates this file.

Reference reviewed and refreshed on 2026-08-31 after the Season 1 challenge
version 1.1.0 gallery update. SHA-256:
`c856acc0a3be4d5144a79a54d1679f6418313a35a340e8d86289bd4b30153b77`.

The visual-reference test injects its fixed fixture clock so measured runtime
labels remain stable; measured, zero, and unknown operational values are
covered separately by the presentation and gallery tests.
