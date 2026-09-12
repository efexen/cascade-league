# Security policy

## Reporting

Do not open a public issue containing credentials, provider request IDs, private prompts, raw model output, logs, unpublished generation artifacts, or details that would expose an active account. Contact the repository maintainers through a private channel available on the repository host. If no private channel is published, disclose only that you need one; do not include the sensitive report publicly.

There is currently no published response-time or supported-version commitment.

## Operator security boundary

Command adapters execute operator-configured local programs. Review every absolute executable and argument before granting `--allow-model-calls`.

- `environmentAllowlist` narrows inherited variables; it is not a complete process, filesystem, network, plugin, MCP, or provider-account sandbox.
- The bundled Codex/OpenCode wrappers rely on existing user authentication under `HOME` and may inherit capabilities from local CLI configuration. Use a dedicated account/configuration if stronger separation is required.
- `--accept-prompt-only-one-shot` records a known enforcement limitation. It does not technically prevent an agent from making internal turns or using every locally available capability.
- Timeouts and token declarations are not universal provider-side spend limits. Set provider-side controls and begin with a small smoke roster.
- Never commit real profiles, credentials, model responses, generations, or static exports without a deliberate privacy review.

Treat the generation root as private. Use the audited static exporter for public material and inspect its output before any manual commit or deployment. The exporter does not publish or grant access to an upstream gallery.
