# Recorded LLM response fixtures

These JSON files are **recorded-shape** responses for the Anthropic `client.messages.parse`
call that `anthropicModel()` (`packages/scan/src/model.ts`) makes. They are transport test
doubles: each file is one full `parse` response — `model`, `usage`, `stop_reason`,
`stop_details`, `content` and `parsed_output` — authored to the `@anthropic-ai/sdk@1.1.0`
response contract.

They let `model.contract.test.ts` exercise our code's half of the contract **deterministically
and offline**: request shape (model, `max_tokens`, system prompt, `output_config.effort`,
message roles), happy-path parsing, refusal handling, the single repair retry on invalid or
truncated output, and the final `ModelError`. No network, no API key, no spend.

They are not scan output and are never presented as a real project's report — they carry a
tiny invented evidence graph (`doc:1`, `route:1`, …) that exists only to drive parsing.

**Ground truth:** the gated live suite (`model.live.test.ts`, run with `RUN_LIVE_LLM=1` and a
real `ANTHROPIC_API_KEY`) calls the real API and asserts the same response shape these
fixtures encode. If the SDK or API contract ever drifts, the live suite fails first; refresh
these fixtures from a live capture when it does.
