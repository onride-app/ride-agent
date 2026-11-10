import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Writable } from "node:stream";
import { it } from "node:test";
import {
  createVenueReadDiagnosticsReporter,
  reportVenueReadDiagnostics,
  sanitizeVenueReadDiagnostics,
  VENUE_READ_DIAGNOSTICS_MAX_BYTES,
} from "./venue-read-diagnostics.js";
import { VenueReads } from "./venue-reads.js";
import { VenueReadBudget } from "./venue-read-budget.js";

function packet(): Record<string, any> {
  const reads = new VenueReads(async () => Response.json({}), Date.now, 2, {
    budget: new VenueReadBudget(),
    report: () => {},
  });
  return reads.diagnostics();
}
function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, report: createVenueReadDiagnosticsReporter(stream) };
}
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

it("preserves the actual producer schema and interval/cumulative values without changing input", () => {
  const value = packet();
  value.interval_ms = 60000;
  value.counts.actual_fetch = 3;
  value.frames.admitted = 100;
  const before = structuredClone(value);
  assert.deepEqual(plain(sanitizeVenueReadDiagnostics(value)), before);
  const next = structuredClone(value);
  next.counts.actual_fetch = 2;
  next.frames.admitted = 101;
  const projected = sanitizeVenueReadDiagnostics(next)!;
  assert.equal((projected.counts as any).actual_fetch, 2);
  assert.equal((projected.frames as any).admitted, 101);
  assert.deepEqual(value, before);
});

it("drops unknown body, URL, owner, frame, key and provider strings at every level", () => {
  const value = packet();
  Object.assign(value, {
    body: "SECRET_BODY",
    url: "https://SECRET",
    owner: "SECRET_OWNER",
  });
  Object.assign(value.budget, {
    redis_key: "SECRET_KEY",
    account_id: "SECRET_ACCOUNT",
  });
  Object.assign(value.counts, {
    provider_message: "SECRET_PROVIDER",
    frame_id: "SECRET_FRAME",
  });
  Object.assign(value.frames, { owner: "SECRET_OWNER" });
  value.methods = [
    {
      purpose_method: "source:clearinghouseState",
      actual_fetch: 4,
      token: "SECRET_TOKEN",
    },
    { purpose_method: "account:SECRET_ADDRESS", calls: 1 },
  ];
  const projected = sanitizeVenueReadDiagnostics(value)!;
  assert.equal((projected.methods as any[])[0].actual_fetch, 4);
  assert.equal((projected.methods as any[]).length, 1);
  assert.equal(projected.omitted_method_rows, 1);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|https:/);
});

it("never turns NaN, infinity, negative counters, inherited fields or getters into zero", () => {
  const value = packet();
  value.counts = Object.assign(Object.create({ calls: 999 }), {
    actual_fetch: NaN,
    http_429: Infinity,
    charged_weight: -1,
    cache_hit: 2,
  });
  let getterCalls = 0;
  Object.defineProperty(value.counts, "unknown_fetch", {
    get() {
      getterCalls++;
      throw Error("SECRET");
    },
  });
  Object.defineProperty(value, "raw_body", {
    get() {
      getterCalls++;
      throw Error("SECRET");
    },
  });
  const counts = sanitizeVenueReadDiagnostics(value)!.counts as any;
  assert.deepEqual(plain(counts), { cache_hit: 2 });
  assert.equal(getterCalls, 0);
  assert.equal(
    sanitizeVenueReadDiagnostics({ event: "OTHER", payload: "SECRET" }),
    undefined,
  );
});

it("preserves only fixed rate-limit classifications and no raw headers", () => {
  const value = packet();
  const response = {
    purpose_method: "source:clearinghouseState",
    content_kind: "json",
    retry_after_kind: "seconds",
    retry_after_ms: 1000,
    server_family: "cloudflare",
    cloudfront_header: false,
    cloudflare_header: true,
    count: 2,
  };
  value.rate_limit_responses = [
    { ...response, authorization: "SECRET", url: "https://SECRET" },
    { ...response, server_family: "SECRET_PROVIDER" },
  ];
  const projected = sanitizeVenueReadDiagnostics(value)!;
  assert.deepEqual(plain(projected.rate_limit_responses), [response]);
  assert.equal(projected.omitted_rate_limit_rows, 1);
  assert.doesNotMatch(JSON.stringify(projected), /SECRET|authorization|https:/);
});

it("bounds huge sparse arrays and emitted UTF8 lines while preserving aggregate counters", () => {
  const value = packet();
  const huge: any[] = [];
  huge.length = 1_000_000_000;
  huge[0] = { purpose_method: "account:userAbstraction", calls: 1 };
  huge[999_999_999] = { purpose_method: "SECRET", payload: "SECRET" };
  value.methods = huge;
  value.rate_limit_responses = Array.from({ length: 200 }, (_, index) => ({
    purpose_method: "source:clearinghouseState",
    content_kind: "json",
    retry_after_kind: "seconds",
    retry_after_ms: 1000,
    server_family: "cloudflare",
    cloudfront_header: false,
    cloudflare_header: true,
    count: index + 1,
  }));
  value.counts.calls = 17;
  const { lines, report } = capture();
  report(value);
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.split("\n").length, 2);
  assert.ok(
    Buffer.byteLength(lines[0]!, "utf8") <= VENUE_READ_DIAGNOSTICS_MAX_BYTES,
  );
  const projected = JSON.parse(lines[0]!);
  assert.equal(projected.counts.calls, 17);
  assert.equal(projected.omitted_method_rows, 999_999_999);
  assert.ok(projected.omitted_rate_limit_rows > 0);
  assert.equal(projected.truncated, true);
  assert.doesNotMatch(lines[0]!, /SECRET/);
});

it("malformed proxies, cycles and synchronous write exceptions cannot affect the caller", () => {
  const value = packet();
  value.body = value;
  const proxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw Error("SECRET");
      },
    },
  );
  const { lines, report } = capture();
  assert.doesNotThrow(() => report(proxy));
  assert.equal(lines.length, 0);
  assert.doesNotThrow(() => report(value));
  const broken = new Writable({
    write() {
      throw Error("SECRET_WRITE_ERROR");
    },
  });
  const brokenReport = createVenueReadDiagnosticsReporter(broken);
  assert.doesNotThrow(() => brokenReport(value));
  assert.equal(typeof reportVenueReadDiagnostics, "function");
});

function child(program: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", program],
    {
      encoding: "utf8",
      timeout: 10000,
    },
  );
}
const moduleUrl = new URL("./venue-read-diagnostics.ts", import.meta.url).href;
it("default reporter writes exactly one stderr JSON line and zero stdout", () => {
  const result =
    child(`import { reportVenueReadDiagnostics } from ${JSON.stringify(moduleUrl)};
reportVenueReadDiagnostics({event:'venue_read_budget',counts:{calls:1},body:'SECRET',methods:[]});`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stderr).event, "venue_read_budget");
  assert.doesNotMatch(result.stderr, /SECRET/);
});

it("asynchronous EPIPE and stream error events are isolated without a global error handler", () => {
  const result = child(`import { Writable } from 'node:stream';
import { createVenueReadDiagnosticsReporter } from ${JSON.stringify(moduleUrl)};
const sink=new Writable({write(_chunk,_encoding,done){setImmediate(()=>done(Object.assign(new Error('SECRET_EPIPE'),{code:'EPIPE'})));}});
const report=createVenueReadDiagnosticsReporter(sink);
report({event:'venue_read_budget',counts:{calls:1},methods:[]});
setTimeout(()=>process.stdout.write('business-continued'),30);`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "business-continued");
  assert.equal(result.stderr, "");
});
