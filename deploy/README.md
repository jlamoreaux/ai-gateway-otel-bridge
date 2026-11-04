# Deploying

The collector is stateless. Run it anywhere that can (a) reach your LangSmith and
(b) make an outbound connection to Cloudflare for the tunnel — e.g. ECS/Fargate or EC2
in the same VPC as LangSmith. **No inbound security-group rules are needed.**

> Status: the local quick-tunnel path in the main README was tested end to end. The named
> tunnel / Access steps below follow Cloudflare's docs but were **not** exercised in this repo.

## 1. Named tunnel

```bash
cloudflared tunnel login
cloudflared tunnel create aig-otel-bridge
cloudflared tunnel route dns aig-otel-bridge otel.example.com
```

Either use a remotely-managed tunnel (dashboard → Zero Trust → Networks → Tunnels) and set
the public hostname service to `http://collector:4318`, or run with a local config:

```yaml
# config.yml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: otel.example.com
    service: http://collector:4318
  - service: http_status:404
```

`docker-compose.named-tunnel.yaml` runs `cloudflared` next to the collector using
`TUNNEL_TOKEN`:

```bash
export TUNNEL_TOKEN=...
PROFILE=langsmith OVERLAY=ingest-auth \
  docker compose -f docker-compose.yaml -f deploy/docker-compose.named-tunnel.yaml up -d
```

## 2. Protect the hostname

Pick one (or both):

- **Bearer token (built in):** `OVERLAY=ingest-auth` + `INGEST_TOKEN`; put
  `Authorization: Bearer <token>` in the gateway exporter headers. Tested.
- **Cloudflare Access service token:** create an Access application for `otel.example.com`
  with a Service Auth policy, then put `CF-Access-Client-Id` and `CF-Access-Client-Secret` in
  the gateway exporter headers. Access rejects unauthenticated requests before they reach
  your network.

```bash
node src/cli.ts set-exporter <gateway-id> --url https://otel.example.com/v1/traces \
  --header "CF-Access-Client-Id=..." \
  --header "CF-Access-Client-Secret=..." \
  --header "Authorization=Bearer $INGEST_TOKEN"
```

## 3. Run the collector in AWS

Use the same image and config files. On ECS, mount `collector/` (or bake it into your own
image `FROM otel/opentelemetry-collector-contrib` with `COPY collector /etc/otelcol`) and run:

```
--config=/etc/otelcol/base.yaml
--config=/etc/otelcol/profiles/langsmith.yaml
--config=/etc/otelcol/overlays/ingest-auth.yaml
```

Provide `LANGSMITH_API_KEY`, `LANGSMITH_PROJECT`, `LANGSMITH_OTLP_TRACES_ENDPOINT`
(self-hosted: `https://<host>/api/v1/otel/v1/traces`) and `INGEST_TOKEN` from Secrets Manager.
A Terraform module is not included yet.
