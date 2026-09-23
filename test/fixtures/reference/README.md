# Gallery visual reference

`gallery-screenshot.png` is a checked-in full-height rendering reference for the
fixture tournament at a fixed `1280px` viewport width, capped at `12000px` tall. It captures the champion stylesheet directly without a system gallery layout override. The test ignores per-channel changes of up
to eight levels, permits at most `0.5%` changed pixels, and rejects any channel
delta above 32. This small allowance covers native M4/macOS font rasterisation
variation; it is not an artistic-quality score.

Browser, font, Playwright, template, or stylesheet upgrades require an
explicit human review of the reference before replacing it. The test never
auto-updates this file.

Reference reviewed and refreshed on 2026-09-23 after removing the system-owned
gallery layout override. The screenshot was inspected from a fresh fixture run.
SHA-256: `2ed8c6fe5173d264d6b3f9e71436890104cd521f3cd29afb5f27a7a771c3e930`.

The visual-reference test injects its fixed fixture clock so measured runtime
labels remain stable; measured, zero, and unknown operational values are
covered separately by the presentation and gallery tests.
