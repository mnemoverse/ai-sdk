/**
 * The identity-bound apiFetch: request shape, security rules, error classes,
 * and the configuration refusals decided when it is built.
 */
import { refusePlaceholderKey } from "@mnemoverse/mcp-memory-server/dist/requests.js";
import * as shared from "@mnemoverse/mcp-memory-server/shared";
import { describe, expect, it, vi } from "vitest";
import { createApiFetch, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS, mergeSignals } from "../src/api-fetch.js";
import { MnemoverseConfigError } from "../src/errors.js";
import { DEFAULT_BASE_URL, isUnsendableKey } from "../src/refusals.js";
import { fixtureFetch, type Routes } from "./helpers/fixture-fetch.mjs";

const KEY = "mk_live_deadbeef";
const BASE = DEFAULT_BASE_URL;

function setup(
  routes: Routes = { "GET /ping": { json: { ok: true } } },
  extra: Partial<Parameters<typeof createApiFetch>[0]> = {},
) {
  const fixture = fixtureFetch(routes, { baseUrl: extra.baseUrl ?? BASE });
  const apiFetch = createApiFetch({ apiKey: KEY, baseUrl: BASE, fetch: fixture.fetch, ...extra });
  return { fixture, apiFetch };
}

function refusal(fn: () => unknown): MnemoverseConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(MnemoverseConfigError);
    return error as MnemoverseConfigError;
  }
  throw new Error("expected a MnemoverseConfigError");
}

describe("request shape", () => {
  it("sends ${baseUrl}${path} with JSON content type, the key and redirect: 'error'", async () => {
    const { fixture, apiFetch } = setup({ "POST /memory/read": { json: { items: [] } } });
    await expect(apiFetch("/memory/read", { method: "POST", body: "{}" })).resolves.toEqual({ items: [] });
    expect(fixture.calls).toEqual([
      {
        url: `${BASE}/memory/read`,
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": KEY },
        body: "{}",
        redirect: "error",
        hasSignal: true,
      },
    ]);
  });

  it("does not normalise the base URL: the URL is baseUrl + path", async () => {
    const baseUrl = "https://core.example.com/api/v1/";
    const { fixture, apiFetch } = setup({ "GET /ping": { json: {} } }, { baseUrl });
    await apiFetch("/ping");
    expect(fixture.calls[0]!.url).toBe("https://core.example.com/api/v1//ping");
  });

  it("forces redirect: 'error' even when the caller asks to follow", async () => {
    const { fixture, apiFetch } = setup();
    await apiFetch("/ping", { redirect: "follow" });
    expect(fixture.calls[0]!.redirect).toBe("error");
  });

  it("looks up globalThis.fetch per request when none is injected", async () => {
    const apiFetch = createApiFetch({ apiKey: KEY, baseUrl: BASE });
    const fixture = fixtureFetch({ "GET /ping": { json: { late: true } } });
    vi.stubGlobal("fetch", fixture.fetch);
    await expect(apiFetch("/ping")).resolves.toEqual({ late: true });
    expect(fixture.calls).toHaveLength(1);
  });
});

describe("configuration refusals: when apiFetch is built, before any request", () => {
  it.each([
    ["an empty key", "", "missing_key"],
    ["a blank key", "   ", "missing_key"],
    ["a line break inside the key", "mk_live_dead\nbeef", "unsendable_key"],
    ["a control character inside the key", "mk_live_dead\u0007beef", "unsendable_key"],
    ["a character above U+00FF", "mk_live_dead beef", "unsendable_key"],
  ])("%s", (_label, apiKey, code) => {
    const error = refusal(() => createApiFetch({ apiKey, baseUrl: BASE }));
    expect(error.code).toBe(code);
    if (apiKey.trim() !== "") expect(error.message).not.toContain("beef");
  });

  it("a non-string key is a missing key", () => {
    expect(refusal(() => createApiFetch({ apiKey: undefined as unknown as string, baseUrl: BASE })).code).toBe(
      "missing_key",
    );
  });

  it.each([["mk_live_YOUR_KEY"], ["mk_live_USER_KEY"], ["mk_live_xxxxxxxxxxxxxxxxxxxxxxxx"]])(
    "the documentation placeholder %s is refused with the package's own text, not a re-typed copy",
    (apiKey) => {
      const error = refusal(() => createApiFetch({ apiKey, baseUrl: BASE }));
      expect(error.code).toBe("placeholder_key");
      expect(error.message).toBe(refusePlaceholderKey(apiKey)!.startupLog);
    },
  );

  it("a truncated real key and a mixed-case label are NOT placeholders (the package's decision)", () => {
    for (const apiKey of ["mk_live_deadbeef", "mk_live_Your_Key", "self-hosted-static-key"]) {
      expect(() => createApiFetch({ apiKey, baseUrl: BASE }), apiKey).not.toThrow();
    }
  });

  it("surrounding whitespace is fine (fetch strips it); tabs and Latin-1 are sendable", () => {
    for (const ok of [KEY, ` ${KEY}`, `${KEY}\n`, `\r\n${KEY}\r\n`, `\t${KEY}\t`, "mk_live_dead\tbeef", "mk_live_déadbeef"]) {
      expect(isUnsendableKey(ok), JSON.stringify(ok)).toBe(false);
    }
    for (const bad of ["a\nb", "a\rb", "a\u0000", "\u0000a", "a\u0001b", "a\u001fb", "a\u007fb", "aĀb", "a😀b"]) {
      expect(isUnsendableKey(bad), JSON.stringify(bad)).toBe(true);
    }
  });

  it.each([
    ["https://core.mnemoverse.com/api/v1"],
    ["http://localhost:8100/api/v1"],
    ["http://127.0.0.1:8100"],
    ["http://[::1]:8100"],
  ])("allows %s", (baseUrl) => {
    expect(() => createApiFetch({ apiKey: KEY, baseUrl })).not.toThrow();
  });

  it.each([
    ["http://core.example.com/api/v1"],
    ["http://localhost.evil.example"],
    ["http://evil.localhost"],
    ["http://[::ffff:127.0.0.1]"],
    ["ftp://localhost"],
    ["ws://127.0.0.1"],
    ["core.example.com/api/v1"],
    ["https://user:hunter2@"],
  ])("refuses %s and never quotes the URL", (baseUrl) => {
    const error = refusal(() => createApiFetch({ apiKey: KEY, baseUrl }));
    expect(error.code).toBe("insecure_base_url");
    expect(error.message).not.toContain(baseUrl);
    expect(error.message).not.toContain("hunter2");
  });

  // Regression: a URL with credentials passed the scheme check, then every
  // request failed with a TypeError quoting the whole URL, password included,
  // which the package put in the NetworkError text the model reads.
  it.each([
    ["https://proxyuser:S3CRET-PW@proxy.internal.example/api/v1"],
    ["https://proxyuser@proxy.internal.example/api/v1"],
    ["https://:S3CRET-PW@core.mnemoverse.com/api/v1"],
    ["http://engine:S3CRET-PW@localhost:8100/api/v1"],
  ])("refuses a base URL with a user name or password, %s, without repeating either", (baseUrl) => {
    const error = refusal(() => createApiFetch({ apiKey: KEY, baseUrl }));
    expect(error.code).toBe("insecure_base_url");
    expect(error.message).toMatch(/user name or password/);
    for (const secret of ["S3CRET-PW", "proxyuser", "engine:", baseUrl]) expect(error.message).not.toContain(secret);
  });

  it("a malformed configured header is refused without repeating its value", () => {
    const error = refusal(() =>
      createApiFetch({ apiKey: KEY, baseUrl: BASE, headers: { "X-Trace": "tok_secret\nvalue" } }),
    );
    expect(error.message).toContain("X-Trace");
    expect(error.message).not.toContain("tok_secret");
  });

  // Regression: the error named the offending header by its NAME, and a
  // credential pasted in whole as a name ("Authorization: Bearer …") went into
  // the message, and from there into logs.
  it.each([
    ["a whole Authorization line as the name", { "X-Trace": "t-1", "Authorization: Bearer sk-SECRET-123": "" }, "header 2 of 2"],
    ["a name with a space", { "Bearer sk-SECRET-123": "x" }, "header 1 of 1"],
    ["a name with a line break", { "sk-SECRET-123\n": "x" }, "header 1 of 1"],
    ["pairs", [["X-Trace", "t-1"], ["Authorization: Bearer sk-SECRET-123", "x"]], "header 2 of 2"],
  ])("a header NAME that is not a valid name is never repeated: %s", (_label, headers, where) => {
    const error = refusal(() => createApiFetch({ apiKey: KEY, baseUrl: BASE, headers: headers as never }));
    expect(error.code).toBe("invalid_option");
    for (const secret of ["sk-SECRET-123", "Bearer", "SECRET"]) expect(error.message).not.toContain(secret);
    expect(error.message).toContain(`the name of ${where}`);
  });

  it("a valid but unusual header name with a bad value is not repeated either (it could be a token)", () => {
    const error = refusal(() =>
      createApiFetch({ apiKey: KEY, baseUrl: BASE, headers: { mk_live_SECRETNAME: "v\nx", "X-Trace": "t" } }),
    );
    expect(error.message).not.toContain("SECRETNAME");
    expect(error.message).toContain("header 1 of 2");
  });

  it.each([
    [0],
    [-1],
    [Number.NaN],
    ["10" as unknown as number],
    [null as unknown as number],
    [1.5],
    [Infinity],
    [-Infinity],
    [MAX_TIMEOUT_MS + 1],
    [Number.MAX_SAFE_INTEGER],
  ])("timeoutMs %s is refused: only whole milliseconds from 1 to 2147483647", (timeoutMs) => {
    const error = refusal(() => createApiFetch({ apiKey: KEY, baseUrl: BASE, timeoutMs }));
    expect(error.code).toBe("invalid_option");
    expect(error.message).toContain("2147483647");
  });

  it.each([[1], [MAX_TIMEOUT_MS]])("timeoutMs %s is accepted", (timeoutMs) => {
    expect(() => createApiFetch({ apiKey: KEY, baseUrl: BASE, timeoutMs })).not.toThrow();
  });
});

describe("the built apiFetch rejects only with the package's three classes", () => {
  it("204 and content-length 0 resolve to {}", async () => {
    const { apiFetch } = setup({
      "POST /a": { status: 204 },
      "POST /b": { status: 200, text: "", headers: { "content-length": "0" } },
    });
    await expect(apiFetch("/a", { method: "POST" })).resolves.toEqual({});
    await expect(apiFetch("/b", { method: "POST" })).resolves.toEqual({});
  });

  it("non-2xx → the package's ApiError, with status, body and Retry-After", async () => {
    const { apiFetch } = setup({
      "POST /memory/write": { status: 429, headers: { "retry-after": "7" }, json: { detail: "slow down" } },
    });
    const error = await apiFetch("/memory/write", { method: "POST" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(shared.ApiError);
    expect(error).toMatchObject({ status: 429, method: "POST", path: "/memory/write" });
    expect((error as shared.ApiError).body).toContain("slow down");
  });

  it("a bare 404 is recognisable (memory_list_recent branches on isBare404)", async () => {
    const { apiFetch } = setup({ "POST /memory/recent": { status: 404, json: { detail: "Not Found" } } });
    const error = (await apiFetch("/memory/recent", { method: "POST" }).catch((e: unknown) => e)) as shared.ApiError;
    expect(error).toBeInstanceOf(shared.ApiError);
    expect(error.isBare404).toBe(true);
  });

  it("fetch rejecting → NetworkError", async () => {
    const { apiFetch } = setup({ "GET /ping": { reject: "ECONNREFUSED" } });
    await expect(apiFetch("/ping")).rejects.toBeInstanceOf(shared.NetworkError);
  });

  it("a 2xx body that is not JSON → UnreadableBodyError", async () => {
    const { apiFetch } = setup({ "GET /ping": { text: "<html>captive portal</html>" } });
    await expect(apiFetch("/ping")).rejects.toBeInstanceOf(shared.UnreadableBodyError);
  });

  it("a body stream that dies → UnreadableBodyError keeping the status", async () => {
    const { apiFetch } = setup({
      "GET /a": { status: 502, bodyError: "terminated" },
      "GET /b": { status: 200, bodyError: "terminated" },
    });
    await expect(apiFetch("/a")).rejects.toMatchObject({ status: 502 });
    await expect(apiFetch("/b")).rejects.toBeInstanceOf(shared.UnreadableBodyError);
  });

  it("a header a handler passes that cannot be built → NetworkError whose cause never quotes it", async () => {
    const { fixture, apiFetch } = setup();
    const error = (await apiFetch("/ping", { headers: { "X-Trace": "tok_secret\nvalue" } }).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(shared.NetworkError);
    expect(error.message).not.toContain("tok_secret");
    expect(String((error.cause as Error).message)).not.toContain("tok_secret");
    expect(fixture.calls).toHaveLength(0);
  });
});

describe("timeout", () => {
  it("defaults to 10 s per request", () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(10_000);
  });

  it("a hung request times out as a NetworkError", async () => {
    const { apiFetch } = setup({ "GET /slow": { hang: true } }, { timeoutMs: 30 });
    const error = await apiFetch("/slow").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(shared.NetworkError);
    expect(((error as Error).cause as Error).name).toBe("TimeoutError");
  });

  it("the largest accepted timeout really waits (a timer given more fires after 1 ms)", async () => {
    expect(MAX_TIMEOUT_MS).toBe(2 ** 31 - 1);
    const { fixture, apiFetch } = setup({ "GET /slow": { hang: true } }, { timeoutMs: MAX_TIMEOUT_MS });
    const pending = apiFetch("/slow").then(
      () => "settled",
      () => "rejected",
    );
    const state = await Promise.race([pending, new Promise((r) => setTimeout(() => r("pending"), 50))]);
    expect(state).toBe("pending");
    expect(fixture.calls[0]!.hasSignal).toBe(true);
  });

  it("the handler's own signal (the package's 4 s scope probes) is merged with the timeout, not replaced", async () => {
    const probe = new AbortController();
    const { apiFetch } = setup({ "GET /memory/stats": { hang: true } });
    const pending = apiFetch("/memory/stats", { signal: probe.signal }).catch((e: unknown) => e);
    probe.abort(new Error("probe deadline"));
    expect(((await pending) as Error).cause).toMatchObject({ message: "probe deadline" });

    const quiet = new AbortController();
    const timed = setup({ "GET /memory/stats": { hang: true } }, { timeoutMs: 30 });
    const error = await timed.apiFetch("/memory/stats", { signal: quiet.signal }).catch((e: unknown) => e);
    expect(((error as Error).cause as Error).name).toBe("TimeoutError");
    expect(quiet.signal.aborted).toBe(false);
  });

  it("mergeSignals falls back to a listener merge without AbortSignal.any", () => {
    const any = AbortSignal.any;
    try {
      (AbortSignal as { any?: unknown }).any = undefined;
      const a = new AbortController();
      const b = new AbortController();
      const merged = mergeSignals([a.signal, undefined, b.signal])!;
      expect(merged.aborted).toBe(false);
      b.abort("second");
      expect(merged.reason).toBe("second");
      const pre = new AbortController();
      pre.abort("already");
      expect(mergeSignals([a.signal, pre.signal])!.reason).toBe("already");
    } finally {
      (AbortSignal as { any?: unknown }).any = any;
    }
    expect(mergeSignals([undefined])).toBeUndefined();
  });
});

describe("headers: no caller header can set a credential, in any letter case", () => {
  const spellings = ["x-api-key", "X-API-KEY", "X-Api-Key", "x-Api-kEy", "authorization", "Authorization", "AUTHORIZATION"];

  it.each(spellings.map((h) => [h]))("configured header %s is dropped", async (name) => {
    const { fixture, apiFetch } = setup(undefined, { headers: { [name]: "attacker", "X-Trace": "t-1" } });
    await apiFetch("/ping");
    const sent = fixture.calls[0]!.headers;
    expect(sent["x-api-key"]).toBe(KEY);
    expect(sent.authorization).toBeUndefined();
    expect(sent["x-trace"]).toBe("t-1");
  });

  it.each(spellings.map((h) => [h]))("per-request header %s is dropped (object, Headers and pairs)", async (name) => {
    const { fixture, apiFetch } = setup();
    await apiFetch("/ping", { headers: { [name]: "attacker" } });
    await apiFetch("/ping", { headers: new Headers([[name, "attacker"]]) });
    await apiFetch("/ping", { headers: [[name, "attacker"]] });
    for (const call of fixture.calls) {
      expect(call.headers["x-api-key"]).toBe(KEY);
      expect(call.headers.authorization).toBeUndefined();
      expect(Object.values(call.headers)).not.toContain("attacker");
    }
  });

  it("Content-Type can be overridden", async () => {
    const { fixture, apiFetch } = setup(undefined, { headers: { "content-type": "application/json; charset=utf-8" } });
    await apiFetch("/ping");
    expect(fixture.calls[0]!.headers["content-type"]).toBe("application/json; charset=utf-8");
  });
});
