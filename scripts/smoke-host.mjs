/**
 * Smoke test for the host half: validates password rules, the fallback pool,
 * the Remote marker registration, and the LLM call path with a stubbed ctx.
 * Run: node scripts/smoke-host.mjs  (from the package directory)
 */
import { createRequire } from "node:module";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);

// The real typert-protocol for the marker table + TypertRemoteService base.
const { Remote, TypertRemoteService, remoteMethods } = require("@deepseek-ai/dsh-typert-protocol");
// The real cordis Service base the TypertRemoteService extends.
const { Service } = require("@deepseek-ai/cordis");

const host = await import("../lib/index.js");
const { PasswordGeneratorRuntime, validatePassword, buildFallbackPassword, normalizeLength, normalizeMeaningful, splitModelOutput, pickSeed } = host;

/* 1 ── validation rules (the structural LLM-output gate) ── */
assert.equal(validatePassword("Short", 16), false, "length mismatch rejected");
assert.equal(validatePassword("password123", 11), false, "missing upper/symbol classes rejected");
assert.equal(validatePassword("A".repeat(16), 16), false, "single class rejected");
assert.equal(validatePassword("Abcd2345!@#$Wxyz", 16), true, "well-formed 16-char password accepted");
// Meaningful constants may contain confusables (π digits have 1) — that is the
// point of the tier; the gate stays structural.
assert.equal(validatePassword("Pi=3.14159!Sqrt2", 16), true, "meaningful password with confusables accepted");
assert.equal(validatePassword("Abcdef12!@#", 11), true, "well-formed 11-char password accepted");

/* 1b ── meaningful normalization pads short-but-valid output to the target ── */
const padded = normalizeMeaningful("Euler3.14159!", 16);
assert.equal(padded.length, 16, "short meaningful output padded to 16");
assert.equal(validatePassword(padded, 16), true, "padded password passes the structural gate");
assert.equal(padded.startsWith("Euler3.14159!"), true, "meaningful core preserved at the front");

/* 1c ── two-line output split + specific meaning note (demo-style provenance) ── */
assert.deepEqual(splitModelOutput("Pi3.14!Orbit\n电影 · 泰坦尼克号沉没 · 1912年"), {
  passwordRaw: "Pi3.14!Orbit",
  meaning: "电影 · 泰坦尼克号沉没 · 1912年",
});
assert.deepEqual(splitModelOutput("  abc123!@  \n  行2  \n\n行3"), {
  passwordRaw: "abc123!@",
  meaning: "行2 行3",
});
assert.deepEqual(splitModelOutput("only-one-line"), { passwordRaw: "only-one-line", meaning: "" });
// The structured seed table: a random pick returns topic → subcategory → leaf seed,
// and the recent-seed dedup means no leaf key repeats within the recency window.
const seenKeys = [];
for (let i = 0; i < 60; i++) {
  const { topic, subcategory, seed } = pickSeed();
  assert.equal(typeof topic.label, "string");
  assert.equal(typeof subcategory.label, "string");
  assert.equal(typeof seed.desc, "string");
  assert.equal(typeof seed.word, "string");
  assert.equal(typeof seed.digits, "string");
  const key = `${topic.label}|${subcategory.label}|${seed.desc}`;
  assert.ok(!seenKeys.includes(key), `no repeat within window: ${key} repeated`);
  seenKeys.push(key);
  if (seenKeys.length > 16) seenKeys.shift();
}
assert.equal(normalizeMeaningful("Euler3.14159!", 16).length, 16);
assert.equal(normalizeMeaningful("tiny", 16), null, "too-short output rejected");
assert.equal(normalizeMeaningful("WayWayWayWayWayWayWayWayWayLong1!", 16), null, "over-length output rejected");
assert.equal(normalizeMeaningful("Aaaaaaaa", 16), null, "single-class output rejected");
// Curated fallback content (π digits contain 1, "Euler" contains l) is exempt
// from the confusable-exclusion gate — only the structural contract applies.
const sample = buildFallbackPassword({ word: "Euler", digits: "2.71828182", note: "e" }, 16);
assert.equal(sample.length, 16, "fallback password is exactly 16 chars");
for (const set of ["abcdefghjkmnpqrstuvwxyz", "ABCDEFGHJKMNPQRSTUVWXYZ", "23456789", "!@#$%^&*()-_=+[]{};:,.<>?"]) {
  assert.equal([...sample].some((ch) => set.includes(ch)), true, `fallback covers class ${set[0]}`);
}

/* 2 ── length normalization ── */
assert.equal(normalizeLength(undefined), 16);
assert.equal(normalizeLength(20), 20);
assert.equal(normalizeLength(3), 16, "too short clamped to default");
assert.equal(normalizeLength(99), 16, "too long clamped to default");
assert.equal(normalizeLength("x"), 16);

/* 3 ── fallback pool always produces structurally valid passwords ── */
for (const entry of host.FALLBACK_POOL ?? []) {
  for (let i = 0; i < 200; i++) {
    const pw = buildFallbackPassword(entry, 16);
    assert.equal(pw.length, 16, `pool entry ${entry.word} length`);
    for (const set of ["abcdefghjkmnpqrstuvwxyz", "ABCDEFGHJKMNPQRSTUVWXYZ", "23456789", "!@#$%^&*()-_=+[]{};:,.<>?"]) {
      assert.equal([...pw].some((ch) => set.includes(ch)), true, `pool entry ${entry.word} class coverage`);
    }
  }
}

/* 4 ── Remote marker registration ── */
class CtxStub {
  constructor() {
    this.props = {};
    this.reflect = { provide: (key, value) => { this.props[key] = { type: "service", value }; } };
    this.fiber = { state: 2 };
  }
}
const ctx = new CtxStub();
const runtime = new PasswordGeneratorRuntime(ctx);
assert.equal(runtime.name, "passwordGenerator", "service registered under passwordGenerator");
assert.equal(runtime.typertRemote.serviceKey, "passwordGenerator");
assert.equal(runtime.typertRemote.namespace, "passwordGenerator");
assert.ok(runtime instanceof TypertRemoteService, "extends TypertRemoteService");
assert.ok(runtime instanceof Service, "is a cordis Service");
const markers = remoteMethods(runtime);
assert.equal(markers.length, 1, "exactly one Remote marker");
assert.equal(markers[0].method, "generateMeaningful", "marker names the Remote method");
assert.deepEqual(markers[0].invocation, { kind: "direct" });

/* 5 ── generateMeaningful: LLM path returns validated output ── */
const calls = [];
const llmCtx = {
  ctx: {
    agentDefaultModel: {
      currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    },
    llm: {
      stream: async function* (options) {
        calls.push(options);
        // The model may still emit a trailing meaning line; the note comes from
        // the seed path, not the model, so only line 1 (the password) matters.
        const text = "sQrT22.22222222!\nanything the model says";
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text };
        yield { type: "block-end", index: 0, block: { type: "text", text } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  },
};
const result = await runtime.generateMeaningful.call(llmCtx, { length: 16 });
assert.equal(result.password.length, 16);
assert.equal(validatePassword(result.password, 16), true);
// Provenance is the deterministic seed path: 主题 · 子分类 · 具体语义 · 事实
assert.match(result.note, / · .+ · .+ · .+/);

/* 6 ── generateMeaningful: validation retry then fallback ── */
let attempt = 0;
const badCtx = {
  ctx: {
    agentDefaultModel: {
      currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }),
    },
    llm: {
      stream: async function* () {
        attempt += 1;
        // First two attempts produce invalid output ("short"), last produces nothing.
        yield { type: "block-start", index: 0, blockType: "text" };
        yield { type: "text-delta", index: 0, text: attempt < 2 ? "short" : "" };
        yield { type: "block-end", index: 0, block: { type: "text", text: "short" } };
        yield { type: "finish", reason: { kind: "stop" } };
      },
    },
  },
};
const fallback = await runtime.generateMeaningful.call(badCtx, { length: 16 });
assert.equal(fallback.password.length, 16);
// Fallback content is curated memorability text, so only the structural
// contract applies (covered exhaustively in test 3); the note must say so.
assert.match(fallback.note, /本地词库兜底/);
assert.equal(attempt, 3, "retried up to MAX_ATTEMPTS");

/* 7 ── generateMeaningful: stream failure falls back, no throw ── */
const failingCtx = {
  ctx: {
    agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }) },
    llm: {
      stream: async function* () {
        yield { type: "finish", reason: { kind: "error", failure: { message: "boom", code: "X" } } };
      },
    },
  },
};
const withFailingCtx = { ...runtime, ctx: failingCtx.ctx };
const recovered = await runtime.generateMeaningful.call(withFailingCtx, { length: 16 });
assert.equal(recovered.password.length, 16, "stream failure still returns a usable password");
assert.match(recovered.note, /本地词库兜底/);

console.log("ALL HOST SMOKE TESTS PASSED");
