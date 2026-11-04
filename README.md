# ai-gateway-otel-bridge

Get **Cloudflare AI Gateway** OpenTelemetry traces into **LangSmith** — including a
self-hosted LangSmith in a private VPC — and optionally any other OTLP backend.

AI Gateway can export an OTLP span per request, but:

1. The export is made **from Cloudflare's network**, so the destination URL has to be
   reachable from the internet. A private VPC isn't.
2. The span shape doesn't line up with what LangSmith (and most GenAI backends) expect:
   the request and response *bodies* are stuffed into `gen_ai.input.messages` /
   `gen_ai.output.messages`, your `cf-aig-metadata` keys arrive as bare attributes, and
   there's no LangSmith run type.

This repo is a thin, config-only layer on the stock
[OpenTelemetry Collector](https://opentelemetry.io/docs/collector/) that fixes both.

```
AI Gateway ──OTLP──▶ Cloudflare Tunnel (+ Access / bearer) ──▶ Collector (in your VPC) ──▶ LangSmith
 (settings → OpenTelemetry)   outbound-only, no public LB       normalize + profile        /api/v1/otel
```

No custom image is built — it uses the official `otel/opentelemetry-collector-contrib`
image and plain YAML.

## What AI Gateway actually emits

Captured from a live gateway (see `test/fixtures/aig-chat-span.json`). Note this differs
from the attribute names in the AI Gateway docs (`gen_ai.prompt_json` etc.) at the time of
writing:

| Attribute | Value |
| --- | --- |
| span name | `cf.aig.request` |
| `gen_ai.operation.name` | `chat` |
| `gen_ai.provider.name` | `workers-ai` |
| `gen_ai.request.model` | `@cf/meta/llama-3.2-3b-instruct` |
| `gen_ai.usage.input_tokens` / `output_tokens` | ints |
| `gen_ai.usage.cost` | double |
| `gen_ai.input.messages` | **entire request body** as a JSON string |
| `gen_ai.output.messages` | **entire response body** as a JSON string |
| *your `cf-aig-metadata` keys* | bare attributes, e.g. `user_id` |

If AI Gateway changes this, refresh the fixture with the `capture` profile and re-run the tests.

## What the collector does

`collector/base.yaml` (all backends) — `transform/normalize`:
- `gen_ai.input.messages` → the request's `messages` array
- `gen_ai.output.messages` → `[choices[0].message]`
- adds `gen_ai.system` (alias of `gen_ai.provider.name`)
- if a body isn't OpenAI-shaped or isn't JSON, the original value is kept (span is never dropped)

`collector/profiles/langsmith.yaml` — `transform/langsmith` + exporter:
- `langsmith.span.kind = llm`, `langsmith.trace.name = "AI Gateway - <model>"`
- cost → `langsmith.metadata.aig_cost`
- every non-`gen_ai.*` attribute (i.e. `cf-aig-metadata`) → `langsmith.metadata.*`
- exports OTLP/HTTP with `x-api-key` and `Langsmith-Project`

## Quick start (local)

```bash
# 1. collector, printing/saving spans exactly as received
docker compose up -d                       # PROFILE=capture by default
cloudflared tunnel --protocol http2 --url http://localhost:4318   # prints https://<random>.trycloudflare.com

# 2. point a gateway at it
export CLOUDFLARE_API_TOKEN=...            # "AI Gateway Write"
export CLOUDFLARE_ACCOUNT_ID=...
node src/cli.ts set-exporter <gateway-id> --url https://<random>.trycloudflare.com/v1/traces

# 3. send any request through the gateway, then look in ./captures/spans.jsonl
```

`--protocol http2` is only needed if QUIC/UDP is blocked on your network.
Quick tunnels are for testing only — see [deploy/](deploy/README.md) for a named tunnel.

### Send to LangSmith

```bash
export LANGSMITH_API_KEY=lsv2_...
export LANGSMITH_PROJECT=ai-gateway
# SaaS (default) or self-hosted:
export LANGSMITH_OTLP_TRACES_ENDPOINT=https://langsmith.internal.example.com/api/v1/otel/v1/traces
export INGEST_TOKEN=$(openssl rand -hex 24)

PROFILE=langsmith OVERLAY=ingest-auth docker compose up -d --force-recreate
node src/cli.ts set-exporter <gateway-id> \
  --url https://<your-tunnel-host>/v1/traces \
  --header "Authorization=Bearer $INGEST_TOKEN"
```

## Layout

| Path | Purpose |
| --- | --- |
| `collector/base.yaml` | OTLP receiver, `transform/normalize`, batch |
| `collector/profiles/capture.yaml` | dump raw spans (no normalization) |
| `collector/profiles/normalized.yaml` | dump spans after normalization |
| `collector/profiles/langsmith.yaml` | LangSmith destination |
| `collector/profiles/otlp.yaml` | any OTLP/HTTP backend (`OTLP_TRACES_ENDPOINT`, `OTLP_AUTHORIZATION`) |
| `collector/overlays/ingest-auth.yaml` | require `Authorization: Bearer $INGEST_TOKEN` on the receiver |
| `collector/overlays/dryrun.yaml` | swap any profile's exporter for a local file (`captures/dryrun.jsonl`) |
| `src/cli.ts` | `show` / `set-exporter` / `clear-exporter` for a gateway's OTel exporter |
| `deploy/` | named tunnel + Access notes |
| `test/` | integration tests against the real collector |

Compose picks configs with `PROFILE` and up to two overlays, `OVERLAY` and `OVERLAY_2`.
A **profile** adds a destination; an **overlay** modifies behavior. To add a backend, add one
file in `collector/profiles/` that defines an exporter and a `traces` pipeline using
`[transform/normalize, ..., batch]`.

### Why a CLI and not `cf`/the dashboard?

You can use either. The update endpoint is a full `PUT` that requires several unrelated fields,
so the CLI does GET → merge `otel` → PUT of the writable fields to avoid resetting your cache,
rate-limit, retry, and guardrail settings. Header values are redacted in its output.

## Trace linking

Send `cf-aig-otel-trace-id` (32 hex) and `cf-aig-otel-parent-span-id` (16 hex) on requests to
the gateway and the gateway span uses them (verified). **LangSmith drops a span whose parent
was never exported to LangSmith**, so only use parent linking if your app's spans also go to
LangSmith.

## Tests

```bash
npm install
npm test            # needs Docker; starts the real collector per suite
npm run typecheck
```

Covered: normalization, LangSmith attribute mapping, fallback on non-JSON bodies, exporter
wiring (path + `x-api-key` + `Langsmith-Project`) against a mock LangSmith, and the ingest-auth
overlay.

## Known limitations

- **Not yet verified against a real LangSmith.** The exporter wiring is tested against a mock,
  and the attribute mapping follows LangSmith's documented OTLP mapping, but how the run renders
  in the LangSmith UI (and whether a given self-hosted version accepts `/otel`) hasn't been
  confirmed here.
- Message unwrapping targets OpenAI-shaped bodies (what the `/compat` endpoint and most
  providers return). Native Anthropic/Gemini bodies fall back to the raw JSON.
- Only `choices[0]` is mapped for output; streaming and tool-call shapes haven't been tested.
- Spans contain full prompts and completions. Treat the collector, its logs, and the capture
  files as sensitive. Don't use the `capture`/`normalized` profiles in production.

## Supported versions

- **Node.js** (CLI and tests only; the collector does not use Node): 22.23.4+, 24.22.2+ or 26.13.0+. These are the minimum patch levels with the October 2026 security fixes. End-of-life lines (23, 25) are not supported. A further security release is announced for 2026-11-11; bump the floors in `package.json` after it ships. `.nvmrc` and CI use the current LTS (26).
- **OpenTelemetry Collector**: pinned to `otel/opentelemetry-collector-contrib:0.164.0` in `docker-compose.yaml` and `test/helpers.ts`. Dependabot proposes bumps weekly and CI re-runs the tests against them.

## License

Apache-2.0. See [LICENSE](LICENSE).
