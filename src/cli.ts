import { parseArgs } from "node:util";

const USAGE = `Usage:
  node src/cli.ts show           <gateway-id>
  node src/cli.ts set-exporter   <gateway-id> --url <traces-url> [--header K=V ...] [--content-type json|protobuf]
  node src/cli.ts clear-exporter <gateway-id>

Env:
  CLOUDFLARE_API_TOKEN   token with "AI Gateway Write" (read for \`show\`)
  CLOUDFLARE_ACCOUNT_ID  account that owns the gateway

set-exporter replaces the gateway's OTel exporter list with this single exporter.
All other gateway settings are read back and re-sent unchanged.`;

// Fields the update endpoint accepts. The GET response also contains read-only
// fields (id, created_at, ...) that must not be sent back.
const WRITABLE = [
  "authentication", "byok_only", "cache_invalidate_on_update", "cache_ttl",
  "collect_logs", "dlp", "guardrails", "log_classification", "log_management",
  "log_management_strategy", "logpush", "logpush_public_key", "otel",
  "rate_limiting_interval", "rate_limiting_limit", "rate_limiting_technique",
  "retry_backoff", "retry_delay", "retry_max_attempts", "spend_limits",
  "store_id", "stripe", "workers_ai_billing_mode", "zdr",
] as const;

interface OtelExporter {
  url: string;
  headers: Record<string, string>;
  content_type?: "json" | "protobuf";
  authorization?: string;
}

type Gateway = Record<string, unknown> & { otel?: OtelExporter[] };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function env(name: string) {
  return process.env[name] ?? fail(`Missing ${name}\n\n${USAGE}`);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env("CLOUDFLARE_API_TOKEN")}`,
      "content-type": "application/json",
    },
  });
  const body = (await res.json()) as { success: boolean; result: T; errors?: unknown[] };
  if (!res.ok || !body.success) {
    fail(`API ${init?.method ?? "GET"} ${path} failed (${res.status}): ${JSON.stringify(body.errors)}`);
  }
  return body.result;
}

const gatewayPath = (id: string) =>
  `/accounts/${env("CLOUDFLARE_ACCOUNT_ID")}/ai-gateway/gateways/${encodeURIComponent(id)}`;

function writableBody(gateway: Gateway, otel: OtelExporter[] | undefined) {
  const body: Record<string, unknown> = {};
  for (const key of WRITABLE) {
    const value = key === "otel" ? otel : gateway[key];
    if (value !== null && value !== undefined) body[key] = value;
  }
  return body;
}

function redact(exporters: OtelExporter[] | undefined) {
  return (exporters ?? []).map((e) => ({
    ...e,
    headers: Object.fromEntries(Object.keys(e.headers ?? {}).map((k) => [k, "***"])),
    authorization: e.authorization ? "***" : undefined,
  }));
}

function parseHeaders(pairs: string[]) {
  return Object.fromEntries(
    pairs.map((pair) => {
      const i = pair.indexOf("=");
      if (i < 1) fail(`Invalid --header "${pair}", expected K=V`);
      return [pair.slice(0, i), pair.slice(i + 1)];
    }),
  );
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      url: { type: "string" },
      header: { type: "string", multiple: true, default: [] },
      "content-type": { type: "string", default: "json" },
    },
  });
  const [command, gatewayId] = positionals;
  if (!command || !gatewayId) fail(USAGE);

  const gateway = await api<Gateway>(gatewayPath(gatewayId));

  if (command === "show") {
    console.log(JSON.stringify(redact(gateway.otel), null, 2));
    return;
  }

  let otel: OtelExporter[];
  if (command === "set-exporter") {
    if (!values.url) fail(`--url is required\n\n${USAGE}`);
    const contentType = values["content-type"];
    if (contentType !== "json" && contentType !== "protobuf") fail("--content-type must be json or protobuf");
    otel = [{ url: values.url, headers: parseHeaders(values.header), content_type: contentType }];
  } else if (command === "clear-exporter") {
    otel = [];
  } else {
    fail(USAGE);
  }

  const updated = await api<Gateway>(gatewayPath(gatewayId), {
    method: "PUT",
    body: JSON.stringify(writableBody(gateway, otel)),
  });
  console.log(JSON.stringify(redact(updated.otel), null, 2));
}

main();
