import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, it } from "node:test";
import {
  attrMap, loadFixture, post, readSpans, setAttr, sleep, startCollector,
  type RunningCollector,
} from "./helpers.ts";

describe("normalization + langsmith profile (dry run)", () => {
  let c: RunningCollector;
  before(async () => {
    c = await startCollector({
      profile: "langsmith",
      overlays: ["dryrun"],
      env: { LANGSMITH_API_KEY: "test-key" },
    });
  });
  after(() => c.stop());

  it("unwraps request/response bodies into message arrays", async () => {
    const res = await post(c.url, loadFixture());
    assert.equal(res.status, 200);
    const [span] = await readSpans(c.outFile);
    const a = attrMap(span);

    assert.deepEqual(JSON.parse(a["gen_ai.input.messages"]), [
      { role: "user", content: "Say hello in five words." },
    ]);
    const out = JSON.parse(a["gen_ai.output.messages"]);
    assert.equal(out.length, 1);
    assert.equal(out[0].role, "assistant");
    assert.equal(out[0].content, "Hello, how are you today?");
  });

  it("adds langsmith attributes and re-homes cf-aig-metadata", async () => {
    const [span] = await readSpans(c.outFile);
    const a = attrMap(span);

    assert.equal(a["gen_ai.system"], "workers-ai");
    assert.equal(a["langsmith.span.kind"], "llm");
    assert.equal(a["langsmith.trace.name"], "AI Gateway - @cf/meta/llama-3.2-3b-instruct");
    assert.equal(a["langsmith.metadata.user_id"], "poc-user");
    assert.equal(a["langsmith.metadata.team"], "fde");
    assert.ok(a["langsmith.metadata.aig_cost"] > 0);
    assert.equal(a["user_id"], undefined, "bare metadata keys should be moved");
    assert.equal(a["team"], undefined);
    // token usage must survive untouched
    assert.equal(String(a["gen_ai.usage.input_tokens"]), "41");
    assert.equal(String(a["gen_ai.usage.output_tokens"]), "8");
  });
});

describe("fallback behaviour", () => {
  let c: RunningCollector;
  before(async () => {
    c = await startCollector({ profile: "normalized", overlays: ["dryrun"] });
  });
  after(() => c.stop());

  it("leaves non-JSON bodies untouched instead of dropping the span", async () => {
    const payload = setAttr(setAttr(loadFixture(), "gen_ai.input.messages", "not json"), "gen_ai.output.messages", "also not json");
    const res = await post(c.url, payload);
    assert.equal(res.status, 200);
    const [span] = await readSpans(c.outFile);
    const a = attrMap(span);
    assert.equal(a["gen_ai.input.messages"], "not json");
    assert.equal(a["gen_ai.output.messages"], "also not json");
  });
});

describe("langsmith exporter wiring (mock LangSmith)", () => {
  it("sends traces to the OTLP path with api key + project headers", async () => {
    const seen: { url?: string; headers?: Record<string, unknown>; bytes: number }[] = [];
    const server = createServer((req, res) => {
      let bytes = 0;
      req.on("data", (d) => (bytes += d.length));
      req.on("end", () => {
        seen.push({ url: req.url, headers: req.headers, bytes });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    await new Promise<void>((r) => server.listen(0, "0.0.0.0", r));
    const port = (server.address() as { port: number }).port;

    const c = await startCollector({
      profile: "langsmith",
      env: {
        LANGSMITH_API_KEY: "test-key",
        LANGSMITH_PROJECT: "poc-project",
        LANGSMITH_OTLP_TRACES_ENDPOINT: `http://host.docker.internal:${port}/api/v1/otel/v1/traces`,
      },
    });
    try {
      await post(c.url, loadFixture());
      for (let i = 0; i < 40 && seen.length === 0; i++) await sleep(250);
      assert.equal(seen.length, 1, "mock LangSmith should receive one export");
      assert.equal(seen[0].url, "/api/v1/otel/v1/traces");
      assert.equal(seen[0].headers?.["x-api-key"], "test-key");
      assert.equal(seen[0].headers?.["langsmith-project"], "poc-project");
      assert.ok(seen[0].bytes > 0);
    } finally {
      c.stop();
      server.close();
    }
  });
});

describe("ingest-auth overlay", () => {
  let c: RunningCollector;
  before(async () => {
    c = await startCollector({
      profile: "normalized",
      overlays: ["ingest-auth", "dryrun"],
      env: { INGEST_TOKEN: "s3cret" },
    });
  });
  after(() => c.stop());

  it("rejects requests without the bearer token", async () => {
    const res = await post(c.url, loadFixture());
    assert.equal(res.status, 401);
  });

  it("accepts requests with the bearer token", async () => {
    const res = await post(c.url, loadFixture(), { authorization: "Bearer s3cret" });
    assert.equal(res.status, 200);
  });
});
