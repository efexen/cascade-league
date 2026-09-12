# Contributing

Cascade League is a Node.js/TypeScript project. The reference runtime is native Apple Silicon macOS with Node 24 LTS; Node 22.x and Node 24 or newer are accepted by the package and preflight. Node 23 is excluded by the installed test toolchain.

Before changing behavior, read `AGENTS.md` and the ordered historical planning packet it names. Current schemas, CLI help, tests, and checked-in challenge files are the implementation source of truth for operator documentation; record material contract divergence rather than hiding it.

## Setup and checks

```sh
corepack enable
corepack prepare pnpm@10.30.3 --activate
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm garden verify --profile fixture
pnpm verify
```

`pnpm verify` runs typechecking, lint, formatting checks, all tests, and fixture preflight. Tests and documentation validation must not invoke paid models. Use fixture adapters for deterministic coverage and do not regenerate visual references casually.

Keep credentials, `config/profiles/real.local/`, real model output, and generated generations out of commits. Do not weaken argv-array execution, environment allowlists, anonymous judging, immutable artifacts, one-attempt behavior, model-call consent, output escaping, or publication filtering.

No project-level `LICENSE` file exists in this checkout. Do not describe the project as carrying an open-source licence or assume redistribution rights until maintainers add one explicitly.
