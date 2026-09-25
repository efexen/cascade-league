# Season 004 local fonts

These files are copied into the challenge so rendering does not depend on the
host's installed fonts or a network connection. Every binary is distributed
under the SIL Open Font License 1.1. Each family has its own checked-in copy of
the upstream copyright notice and complete OFL text.

| Challenge family      | Checked-in binary         | Licence file                 | SHA-256                                                            | Authoritative upstream licence                                     |
| --------------------- | ------------------------- | ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `LM Neutral Sans`     | `lm-neutral-sans.ttf`     | `OFL-1.1.txt`                | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` | https://github.com/google/fonts/blob/main/ofl/inter/OFL.txt        |
| `LM Display Sans`     | `lm-display-sans.ttf`     | `OFL-1.1-space-grotesk.txt`  | `acad6de1fc93436f5c0f1f4137751ef04f1aea3063e7036535970ffcfbd79f72` | https://github.com/google/fonts/blob/main/ofl/spacegrotesk/OFL.txt |
| `LM Readable Serif`   | `lm-readable-serif.ttf`   | `OFL-1.1-source-serif-4.txt` | `97b2d4da6e3cb494b5a1e66ae176914d852ccabef49e0c02c0df25f3e39aca0b` | https://github.com/google/fonts/blob/main/ofl/sourceserif4/OFL.txt |
| `LM Expressive Serif` | `lm-expressive-serif.ttf` | `OFL-1.1-fraunces.txt`       | `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb` | https://github.com/google/fonts/blob/main/ofl/fraunces/OFL.txt     |
| `LM Mono`             | `lm-mono.ttf`             | `OFL-1.1-ibm-plex-mono.txt`  | `6a3412f058c7d8dfd9170c41e85ade48e5156ecb89356110ca57a0a27734af46` | https://github.com/IBM/plex/blob/master/LICENSE.txt                |

The challenge renames the binaries and declares the local family names in
`starter.css`; contestants may use those names and the relative `fonts/` URLs
only. The checksum is for the exact binary checked into this repository and
can be reproduced with `shasum -a 256 challenge/season-001/fonts/*.ttf`.
