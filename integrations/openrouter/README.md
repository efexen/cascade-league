# OpenRouter direct HTTP integration

These command adapters send one non-streaming request to the official Chat
Completions endpoint. The contestant posts the actual prompt, challenge HTML,
and starter CSS as text. The judge sends prompt and CSS/summary text first, then
local PNGs as `data:image/png;base64,...` image parts. Score attaches candidate
and cohort images; awards attaches the cohort image only. Judge operation is
inferred using the same generic output path aliases documented by the other
bundled judge adapters.

The request requires `--model` and `--max-completion-tokens`, sends
`provider.allow_fallbacks: false`, and does not retry. It rejects HTTP errors,
malformed or oversized responses, missing/empty content, non-normal finish
reasons (including token truncation), invalid judge JSON, and CSS wrapped in
Markdown. Inputs, image bytes, request time, and response bytes are bounded.
Only a loopback HTTP endpoint can be injected by tests; CLI options always use
`https://openrouter.ai/api/v1/chat/completions`.

`OPENROUTER_API_KEY` is read directly from the allowlisted environment. It is
never written to logs, metadata, or profile YAML. Private execution metadata
records the returned request ID/model where present. `usage.json` records token
counts and OpenRouter-reported cost where present and leaves unavailable values
`null`; provider reported cost is still not a dollar-cost guarantee.
`max_completion_tokens`
limits generated output tokens but does not set a universal total-token or
billing ceiling.

## Local credential setup

Create and secure an API key in your own OpenRouter account. Check that the
account is funded or otherwise entitled to use the selected routes, and review
account limits. Do not paste a key into chat, YAML, shell history, a ticket, or
logs. Keep it in a local secret manager or enter it silently into the current
shell session, for example in zsh/bash:

```sh
read -s OPENROUTER_API_KEY
export OPENROUTER_API_KEY
```

Press Return after entering it; close that shell session when finished. The
profile allowlists only the variable name. No `.env` file is loaded.

Preflight can be performed without an account or key using a benign dummy value
because verify and plan do not run adapter commands or send HTTP requests:

```sh
OPENROUTER_API_KEY=offline-preflight-placeholder pnpm garden verify --profile season004.local
OPENROUTER_API_KEY=offline-preflight-placeholder pnpm garden plan-generation \
  --season 004 --profile season004.local \
  --generations-root "$HOME/cascade-runs/season-004" \
  --accept-prompt-only-one-shot
```

The dummy value is only for those no-write structural checks. Successful
preflight does not verify account status, key validity, route entitlement,
credits, image support, provider behavior, or spend. Do not run a smoke or
create a generation until account readiness is checked and Ville explicitly
approves a quoted spending cap. The actual smoke must then be separately
reviewed; there is no account or balance assumed by this integration.

Current API contract references:

- [OpenRouter Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/send-chat-completion-request)
- [OpenRouter image inputs](https://openrouter.ai/docs/guides/overview/multimodal/image-understanding)
