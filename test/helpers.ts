import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..");
export const IMAGE = "otel/opentelemetry-collector-contrib:0.164.0";

export interface CollectorOptions {
  profile: string;
  overlays?: string[];
  env?: Record<string, string>;
}

export interface RunningCollector {
  url: string;
  outFile: string;
  stop: () => void;
}

export interface Attr {
  key: string;
  value: Record<string, unknown>;
}

let counter = 0;

export function loadFixture(name = "aig-chat-span.json") {
  return JSON.parse(readFileSync(resolve(ROOT, "test/fixtures", name), "utf8"));
}

export function setAttr(payload: any, key: string, value: string) {
  const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
  const existing = span.attributes.find((a: Attr) => a.key === key);
  if (existing) existing.value = { stringValue: value };
  else span.attributes.push({ key, value: { stringValue: value } });
  return payload;
}

export async function startCollector(opts: CollectorOptions): Promise<RunningCollector> {
  const id = `${process.pid}-${counter++}`;
  const name = `aig-otel-bridge-test-${id}`;
  const outDir = resolve(ROOT, ".test-out", id);
  mkdirSync(outDir, { recursive: true });
  chmodSync(outDir, 0o777);

  const configs = [
    "base.yaml",
    `profiles/${opts.profile}.yaml`,
    ...(opts.overlays ?? []).map((o) => `overlays/${o}.yaml`),
  ].map((c) => `--config=/etc/otelcol/${c}`);

  const envArgs = Object.entries(opts.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "--add-host=host.docker.internal:host-gateway",
    "-p", "127.0.0.1::4318",
    "-v", `${resolve(ROOT, "collector")}:/etc/otelcol:ro`,
    "-v", `${outDir}:/captures`,
    ...envArgs,
    IMAGE, ...configs,
  ]);

  const stop = () => {
    try { execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }); } catch {}
    rmSync(outDir, { recursive: true, force: true });
  };

  try {
    const mapping = execFileSync("docker", ["port", name, "4318/tcp"]).toString().trim().split("\n")[0];
    const port = mapping.slice(mapping.lastIndexOf(":") + 1);
    const url = `http://127.0.0.1:${port}/v1/traces`;
    await waitUntilUp(url, name);
    return { url, outFile: resolve(outDir, "dryrun.jsonl"), stop };
  } catch (err) {
    stop();
    throw err;
  }
}

async function waitUntilUp(url: string, container: string) {
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      return;
    } catch {
      await sleep(300);
    }
  }
  const logs = execFileSync("docker", ["logs", container]).toString().slice(-2000);
  throw new Error(`collector did not start:\n${logs}`);
}

export function post(url: string, payload: unknown, headers: Record<string, string> = {}) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(payload),
  });
}

export async function readSpans(file: string, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const text = readFileSync(file, "utf8").trim();
      if (text) {
        return text.split("\n").flatMap((line) =>
          JSON.parse(line).resourceSpans.flatMap((rs: any) =>
            rs.scopeSpans.flatMap((ss: any) => ss.spans),
          ),
        );
      }
    }
    await sleep(300);
  }
  throw new Error(`no spans written to ${file}`);
}

export function attrMap(span: { attributes: Attr[] }) {
  const out: Record<string, any> = {};
  for (const a of span.attributes) {
    const v = a.value as any;
    out[a.key] = v.stringValue ?? v.intValue ?? v.doubleValue ?? v.boolValue ?? v;
  }
  return out;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
