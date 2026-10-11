# Third-party notices

Polyglot itself is licensed under CC BY-NC 4.0 (see `LICENSE`).

## Shipped with Polyglot

No third-party code. The review schedule (`src/srs.ts`) is Polyglot's own
implementation of the FSRS-6 algorithm by open-spaced-repetition, using its
published default parameters: as computed by ts-fsrs (MIT), with SM-2 words
converted as fsrs-rs (BSD-3-Clause) does.

## Development only

Used to build and test Polyglot; not shipped with it.

| Software | License |
|---|---|
| TypeScript | Apache-2.0 |
| ESLint | MIT |
| typescript-eslint | MIT / BSD-2-Clause |
| Vitest | MIT |
| ts-fsrs (reference for the FSRS tests in `src/srs.test.ts`) | MIT, © open-spaced-repetition |
| happy-dom (DOM for UI tests) | MIT |
| Zstandard test vectors (`src/deck-import/fixtures/zstd-golden*`, from facebook/zstd) | BSD-3-Clause, © Meta Platforms, Inc. |

## Environment

Polyglot runs inside SillyTavern (AGPL-3.0) and uses its icons (Font Awesome);
neither is included in Polyglot.
