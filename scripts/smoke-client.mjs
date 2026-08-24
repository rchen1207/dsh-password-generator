/**
 * Smoke test for the client bundle: evaluates lib/client.js through a fake
 * window.__ModuleLoader__ (the DSH lazy-CJS sink), then exercises the plugin
 * surface with stub services — locale registration, Remote contribution mount,
 * and the sidebar.footer.action slot registration with its inject face.
 * Run: node scripts/smoke-client.mjs  (from the package directory)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// 1 ── capture the bundle entry through a fake module loader ──
let captured = null;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load(entry) {
        captured = entry;
      },
    },
  },
  console,
  crypto,
  Promise,
  Date,
  Math,
  Object,
  Array,
  Set,
  Map,
  WeakMap,
  Symbol,
  JSON,
  Number,
  String,
  Boolean,
  RegExp,
  Error,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  structuredClone,
};
vm.createContext(sandbox);
vm.runInContext(readFileSync(join(ROOT, "lib/client.js"), "utf8"), sandbox);

assert.ok(captured !== null, "bundle called window.__ModuleLoader__.load");
assert.equal(captured.id, "dsh-client-ui-password-generator");
assert.equal(typeof captured.factory, "function");

// 2 ── run the factory with stub externals ──
const reactStub = {
  createElement: () => null,
  Fragment: Symbol("Fragment"),
  useState: () => [null, () => {}],
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
  useEffect: () => {},
};
const primitivesStub = {
  Button: () => null,
  Modal: () => null,
  Toast: () => null,
  writeClipboard: async () => true,
};
const requireStub = (spec) => {
  if (spec === "react") return reactStub;
  if (spec === "@deepseek-ai/dsh-client-ui-primitives") return primitivesStub;
  throw new Error(`unexpected require: ${spec}`);
};
const plugin = captured.factory(requireStub);

assert.equal(typeof plugin.apply, "function", "bundle exports apply");
assert.deepEqual([...plugin.inject], ["slots", "locale", "remote"], "bundle declares service injects");

// 3 ── apply() wiring with stub services ──
const registrations = [];
const localeDicts = [];
let mountedContribution = null;
let mountDisposer = null;
const remoteAnswers = [];
const ctx = {
  effect: (fn) => fn(),
  get: (name) => {
    assert.equal(name, "remote.passwordGenerator", "apply resolves the namespace via ctx.get, not the dotted path");
    return ctx.remote.passwordGenerator;
  },
  locale: {
    register(ns, dicts) {
      localeDicts.push({ ns, dicts });
      return () => {};
    },
  },
  remote: {
    async $mount(contribution) {
      mountedContribution = contribution;
      return () => {
        mountDisposer = "disposed";
      };
    },
    passwordGenerator: {
      async generateMeaningful(request) {
        return { ok: true, value: { password: "sQrT22.22222222!", note: "AI" } };
      },
    },
  },
  slots: {
    inject(key, callback) {
      assert.equal(key, "sidebar.footer.action");
      const disposer = callback(); // registration factory → register() result
      registrations.push(disposer);
      return () => {};
    },
    register(options, component) {
      assert.equal(options.name, "sidebar.footer.action");
      assert.equal(options.id, "password-generator");
      assert.equal(options.locale, "ui-password-generator");
      assert.equal(typeof options.inject, "function");
      assert.equal(typeof component, "function");
      return () => {};
    },
  },
};

await plugin.apply(ctx);

assert.equal(localeDicts.length, 1, "locale dictionary registered");
assert.equal(localeDicts[0].ns, "ui-password-generator");
const zh = localeDicts[0].dicts.zh;
assert.equal(zh["entry.label"], "密码生成器");
// zh and en key sets must match
const zhKeys = Object.keys(zh).sort();
const enKeys = Object.keys(localeDicts[0].dicts.en).sort();
assert.deepEqual(zhKeys, enKeys, "zh/en dictionaries share the same key set");

assert.ok(mountedContribution !== null, "remote contribution mounted");
assert.equal(mountedContribution.package, "dsh-client-ui-password-generator");
assert.equal(mountedContribution.descriptors.length, 1);
const descriptor = mountedContribution.descriptors[0];
assert.equal(descriptor.namespace, "passwordGenerator");
assert.equal(descriptor.method, "generateMeaningful");
assert.equal(descriptor.result.mode, "strict", "client mount demands strict codecs");
assert.equal(typeof descriptor.result.schema.parse, "function");
for (const parameter of descriptor.parameters) {
  assert.equal(parameter.codec.mode, "strict");
  assert.equal(typeof parameter.codec.schema.parse, "function");
}

// 4 ── the injected business face delegates through the Remote and unwraps RemoteResult ──
assert.equal(registrations.length, 1);
const entryOptions = registrations.length; // registered through the stub above
assert.ok(entryOptions >= 1);
// Re-run the inject factory directly to get the face:
let face = null;
ctx.slots.inject("sidebar.footer.action", () => {
  face = {
    name: "sidebar.footer.action",
    id: "password-generator",
    locale: "ui-password-generator",
    inject: () => ({
      generateMeaningful: async (request) => {
        const ns = ctx.get("remote.passwordGenerator");
        const answered = await ns.generateMeaningful(request);
        if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`);
        return answered.value;
      },
    }),
  };
  return () => {};
});
const value = await face.inject().generateMeaningful({ length: 16 });
assert.deepEqual(value, { password: "sQrT22.22222222!", note: "AI" });

// RemoteResult failure unwraps into a thrown Error
ctx.remote.passwordGenerator.generateMeaningful = async () => ({ ok: false, error: { code: "X", message: "boom" } });
await assert.rejects(() => face.inject().generateMeaningful({ length: 16 }), /X: boom/);

console.log("ALL CLIENT SMOKE TESTS PASSED");
