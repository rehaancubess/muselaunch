# fixtures/agents (FIXTURES — not live output)

Documented-shape fixtures for module B tests. Nothing here was returned by a live service and none of
it may be shown in the product as real output.

- `itunes-lookup.json`: iTunes Lookup API response shape (public Search API docs); fictional app "Tidy Timer".
- `google-play.html`: trimmed Google Play listing page structure (JSON-LD `SoftwareApplication` + screenshot `<img>`s); fictional app.
- `website.html`: a simple product website for the same fictional app.
- `spark-*.json`: Meta Responses API *content* for Muse Spark/Wonder structured outputs. Strings such as
  `$EV:<text>` / `$IMAGE0` / `$SCENE0` are placeholders the test harness resolves to the ids present in
  the request (ids are generated at runtime), so the responses stay grounded in what was actually sent.
- `glimmer-*.txt`: Chat Completions SSE stream bodies in the llama.cpp documented shape.

Live captures from `pnpm smoke:live agents` are written to `fixtures/live/` instead.
