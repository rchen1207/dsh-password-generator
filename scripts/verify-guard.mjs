/**
 * Faithfully reproduce the browser guarded-facade behavior: a cordis plugin
 * fiber with an inject list, remote mounted by its own apply, then access the
 * namespace by (A) the dotted property path and (B) ctx.get. Expect A to throw
 * "without inject" and B to resolve — proving the fix.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const DSH = "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const LIVE = process.env.DSH_PROBE_URL || "http://127.0.0.1:3080";

const registry = new Map();
const sandbox = {
  window: { __ModuleLoader__: { load(e) { registry.set(e.id, e.factory); } } },
  console, crypto, Promise, Date, Math, Object, Array, Set, Map, WeakMap, Symbol,
  JSON, Number, String, Boolean, RegExp, Error,
  setTimeout, clearTimeout, setInterval, clearInterval,
  location: { origin: LIVE },
  fetch: (u, o) => fetch(new URL(u, LIVE), o),
  AbortSignal, AbortController, Event,
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function loadBundle(id, path) {
  vm.runInContext(readFileSync(path, "utf8"), sandbox);
  return registry.get(id)((spec) => {
    if (spec === "@deepseek-ai/cordis") return require("@deepseek-ai/cordis");
    throw new Error(`unmapped: ${spec}`);
  });
}

const cordis = require("@deepseek-ai/cordis");
const typert = loadBundle("@deepseek-ai/dsh-typert-registry", `${DSH}/dsh-typert-registry/lib/client.js`);
const gateway = loadBundle("@deepseek-ai/dsh-api-gateway", `${DSH}/dsh-api-gateway/lib/client.js`);

const pass = { parse: (v) => v };
const CONTRIB = {
  package: "dsh-password-generator",
  descriptors: [{
    id: "dsh-password-generator#passwordGenerator/generateMeaningful",
    service: "passwordGenerator", namespace: "passwordGenerator", method: "generateMeaningful",
    invocation: { kind: "direct" },
    parameters: [{ name: "request", wire: "request", source: "json", codec: { mode: "strict", typeSymbol: "x#request", schema: pass } }],
    result: { mode: "strict", typeSymbol: "x#result", schema: pass },
    sourceLocation: { file: "x", line: 1, column: 1 },
  }],
};

const connection = {
  rpc: { async call(channel, endpoint, payload) {
    const url = `${LIVE}${channel}/${endpoint}`;
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: `g-${Date.now()}`, method: endpoint, payload }) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()).result;
  } },
};

const root = new cordis.Context();
root.provide("connection", connection);
typert.apply(root);
gateway.apply(root);

// A plugin fiber with the same inject list as our client bundle, whose own
// apply mounts the contribution then exposes an invocation closure.
let captured;
const plugin = {
  inject: ["slots", "locale", "remote"],
  async apply(ctx) {
    await ctx.remote.$mount(CONTRIB);
    const ns = ctx.get("remote.passwordGenerator"); // THE FIX
    captured = { ns, ctx };
  },
};

// Provide slots + locale stubs so the fiber's injects resolve.
root.provide("slots", { spec: () => undefined, register: () => () => {}, inject: () => () => {} });
root.provide("locale", { register: () => () => {} });

const fiber = root.plugin(plugin);
await fiber;
const { ns, ctx } = captured;

// (A) dotted path through the plugin fiber ctx
try {
  await ctx.remote.passwordGenerator.generateMeaningful({ length: 16 });
  console.log("A dotted-path: SUCCEEDED (unexpected)");
} catch (e) {
  console.log("A dotted-path: THREW ->", e.message);
}

// (B) ctx.get path (the fix)
try {
  const answered = await ns.generateMeaningful({ length: 16 });
  console.log("B ctx.get path: SUCCEEDED ->", JSON.stringify(answered));
} catch (e) {
  console.log("B ctx.get path: THREW ->", e.message);
}
process.exit(0);
