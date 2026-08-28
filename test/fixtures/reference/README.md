# Gallery visual reference

`gallery-screenshot.png` is a checked-in rendering reference for the fixed
fixture tournament at `1440×1200`. The test ignores per-channel changes of up
to eight levels, permits at most `0.5%` changed pixels, and rejects any channel
delta above 32. This small allowance covers native M4/macOS font rasterisation
variation; it is not an artistic-quality score.

Browser, font, Playwright, template, or stylesheet upgrades require an
explicit human review of the reference before replacing it. The test never
auto-updates this file.
