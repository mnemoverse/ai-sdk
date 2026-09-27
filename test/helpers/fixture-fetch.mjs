/**
 * A route-table `fetch` that never touches the network and records every
 * request. Plain JavaScript on purpose: the reference-server contract test runs
 * it inside a child process next to the REAL MCP stdio entry, and in-process
 * next to this package, so both sides see byte-identical responses.
 *
 * A route key is "METHOD /path" (path relative to the base URL, query
 * included). A route value is a response spec, or an array of them served in
 * order (the last one repeats):
 *
 *   { status?: 200, json?: any, text?: string, headers?: {...} }
 *   { reject: "message" }          fetch() rejects, like a DNS or TLS failure
 *   { bodyError: "message" }       headers arrive, then the body stream errors
 *   { hang: true }                 never answers until the request's signal aborts
 *
 * A request with no route gets status 599 and is listed in `unmatched`.
 */

/** @param {Record<string, unknown>} routes @param {{ baseUrl?: string }} [opts] */
export function fixtureFetch(routes, opts = {}) {
  const baseUrl = opts.baseUrl ?? "https://core.mnemoverse.com/api/v1";
  const calls = [];
  const unmatched = [];
  const served = new Map();

  async function fetch(input, init = {}) {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method ?? "GET").toUpperCase();
    const headers = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    calls.push({
      url,
      method,
      headers,
      body: typeof init.body === "string" ? init.body : init.body == null ? null : String(init.body),
      redirect: init.redirect ?? null,
      hasSignal: init.signal != null,
    });
    const path = url.startsWith(baseUrl) ? url.slice(baseUrl.length) : url;
    const key = `${method} ${path}`;
    let spec = routes[key];
    if (Array.isArray(spec)) {
      const i = served.get(key) ?? 0;
      served.set(key, i + 1);
      spec = spec[Math.min(i, spec.length - 1)];
    }
    if (spec === undefined) {
      unmatched.push(key);
      return new Response(`no fixture for ${key}`, { status: 599 });
    }
    if (spec.hang) {
      return new Promise((_, reject) => {
        const signal = init.signal;
        if (!signal) return;
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    if (spec.reject !== undefined) {
      throw new TypeError("fetch failed", { cause: new Error(spec.reject) });
    }
    const status = spec.status ?? 200;
    const responseHeaders = new Headers(spec.headers ?? {});
    if (spec.bodyError !== undefined) {
      const stream = new ReadableStream({
        start(controller) {
          controller.error(new TypeError(spec.bodyError));
        },
      });
      return new Response(stream, { status, headers: responseHeaders });
    }
    let body = null;
    if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "application/json");
    } else if (spec.text !== undefined) {
      body = spec.text;
    }
    if (status === 204 || status === 304) body = null;
    return new Response(body, { status, headers: responseHeaders });
  }

  return {
    fetch,
    calls,
    unmatched,
    reset() {
      calls.length = 0;
      unmatched.length = 0;
      served.clear();
    },
  };
}
