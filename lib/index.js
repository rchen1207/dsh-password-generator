/**
 * dsh-password-generator — host half
 *
 * Registers the `passwordGenerator` Typert Remote service on the host
 * process. The only Remote method, `generateMeaningful`, asks the default
 * model (through `ctx.llm`) for a memorable 16-character password, validates
 * the shape (length + one of each character class), retries briefly on
 * invalid output, and falls back to a tiny built-in pool when the model is
 * unavailable or keeps failing — always labelled so the UI can show the
 * provenance.
 *
 * Privacy properties (see plan §4):
 *  - the API key lives only in this process; nothing is sent to the browser;
 *  - nothing is written to any storage, session log, or settings;
 *  - the returned password exists for exactly one response and is never
 *    retained afterwards.
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

/** Stable plugin identity recorded with the LLM request source. */
export const name = "dsh-password-generator";

/* ── character sets (identical to the browser half; 0O1lI removed) ── */
export const SETS = Object.freeze({
  lower: "abcdefghjkmnpqrstuvwxyz",
  upper: "ABCDEFGHJKMNPQRSTUVWXYZ",
  digit: "23456789",
  symbol: "!@#$%^&*()-_=+[]{};:,.<>?",
});

const SMART_LENGTH = 16;
const MIN_LENGTH = 8;
const MAX_LENGTH = 32;
const MAX_ATTEMPTS = 3; // one call + up to two retries
const LLM_TIMEOUT_MS = 20000; // never let an auxiliary call hang the UI

/**
 * Structured seed table: topic → subcategory → leaf seed. Each generation picks
 * a random topic, a random subcategory, then a random leaf seed, and hands the
 * leaf to the LLM to GENERATE a truly new password from it (plan §4.5, route B —
 * the password is model-built, never a fixed string, so entropy is preserved).
 * Because the subject is chosen by the table (not left to the model), repetition
 * is structurally bounded, Chinese content is present on demand, and the source
 * line is deterministic (no model-invented 「中国历史」/「世界地理」 prefixes).
 * `word` = romanized keyword for the password, `digits` = the key number.
 */
const TOPICS = Object.freeze([
  {
    label: "历史",
    subcategories: [
      { label: "中国·朝代", seeds: [
        { desc: "秦统一六国", fact: "前221年", word: "Qin", digits: "221" },
        { desc: "唐朝建立", fact: "618年", word: "Tang", digits: "618" },
        { desc: "元朝建立", fact: "1271年", word: "Yuan", digits: "1271" },
        { desc: "明朝建立", fact: "1368年", word: "Ming", digits: "1368" },
      ]},
      { label: "中国·近现代", seeds: [
        { desc: "辛亥革命", fact: "1911年", word: "Xinhai", digits: "1911" },
        { desc: "中华人民共和国成立", fact: "1949年", word: "PRC", digits: "1949" },
        { desc: "改革开放", fact: "1978年", word: "Gaige", digits: "1978" },
      ]},
      { label: "世界·古典", seeds: [
        { desc: "罗马帝国灭亡", fact: "公元476年", word: "Rome", digits: "476" },
        { desc: "君士坦丁堡陷落", fact: "1453年", word: "Byzantium", digits: "1453" },
        { desc: "特洛伊战争", fact: "约前1200年", word: "Troy", digits: "1200" },
        { desc: "马拉松战役", fact: "前490年", word: "Marathon", digits: "490" },
      ]},
      { label: "世界·近现代", seeds: [
        { desc: "法国大革命", fact: "1789年", word: "Bastille", digits: "1789" },
        { desc: "美国独立", fact: "1776年", word: "Liberty", digits: "1776" },
        { desc: "工业革命", fact: "约1760年", word: "Steam", digits: "1760" },
        { desc: "人类首次登月", fact: "1969年", word: "Apollo", digits: "1969" },
      ]},
    ],
  },
  {
    label: "地理",
    subcategories: [
      { label: "中国·山水", seeds: [
        { desc: "珠穆朗玛峰海拔", fact: "8848米", word: "Everest", digits: "8848" },
        { desc: "长江全长", fact: "6300公里", word: "Yangtze", digits: "6300" },
        { desc: "黄河全长", fact: "5464公里", word: "YellowRiver", digits: "5464" },
        { desc: "京杭大运河", fact: "1794公里", word: "Canal", digits: "1794" },
      ]},
      { label: "世界·山水", seeds: [
        { desc: "尼罗河全长", fact: "6650公里", word: "Nile", digits: "6650" },
        { desc: "亚马逊河", fact: "6440公里", word: "Amazon", digits: "6440" },
        { desc: "马里亚纳海沟", fact: "10909米", word: "Mariana", digits: "10909" },
        { desc: "撒哈拉沙漠", fact: "906万平方公里", word: "Sahara", digits: "906" },
      ]},
      { label: "名峰·其他", seeds: [
        { desc: "富士山海拔", fact: "3776米", word: "Fuji", digits: "3776" },
        { desc: "勃朗峰海拔", fact: "4808米", word: "MontBlanc", digits: "4808" },
        { desc: "死海湖面", fact: "低于海平面430米", word: "DeadSea", digits: "430" },
      ]},
    ],
  },
  {
    label: "文学",
    subcategories: [
      { label: "中国·经典", seeds: [
        { desc: "《红楼梦》成书", fact: "约1791年", word: "HongLou", digits: "1791" },
        { desc: "《西游记》成书", fact: "约1592年", word: "XiYouJi", digits: "1592" },
        { desc: "李白诞生", fact: "701年", word: "LiBai", digits: "701" },
        { desc: "杜甫诞生", fact: "712年", word: "DuFu", digits: "712" },
        { desc: "鲁迅《呐喊》", fact: "1923年", word: "LuXun", digits: "1923" },
      ]},
      { label: "世界·经典", seeds: [
        { desc: "莎士比亚诞生", fact: "1564年", word: "Shakespeare", digits: "1564" },
        { desc: "《白鲸》出版", fact: "1851年", word: "MobyDick", digits: "1851" },
        { desc: "《堂吉诃德》出版", fact: "1605年", word: "Quixote", digits: "1605" },
        { desc: "托尔斯泰诞生", fact: "1828年", word: "Tolstoy", digits: "1828" },
        { desc: "《百年孤独》出版", fact: "1967年", word: "Macondo", digits: "1967" },
      ]},
    ],
  },
  {
    label: "音乐",
    subcategories: [
      { label: "中国·名曲", seeds: [
        { desc: "《梁祝》首演", fact: "1959年", word: "LiangZhu", digits: "1959" },
        { desc: "《黄河大合唱》首演", fact: "1939年", word: "YellowRiver", digits: "1939" },
        { desc: "《二泉映月》", fact: "约1950年", word: "Erquan", digits: "1950" },
        { desc: "谭盾《卧虎藏龙》配乐", fact: "2000年", word: "TanDun", digits: "2000" },
      ]},
      { label: "世界·古典", seeds: [
        { desc: "莫扎特诞生", fact: "1756年", word: "Mozart", digits: "1756" },
        { desc: "贝多芬《第九交响曲》首演", fact: "1824年", word: "Ode", digits: "1824" },
        { desc: "巴赫诞生", fact: "1685年", word: "Bach", digits: "1685" },
        { desc: "《卡门》首演", fact: "1875年", word: "Carmen", digits: "1875" },
        { desc: "《茶花女》首演", fact: "1853年", word: "Traviata", digits: "1853" },
      ]},
    ],
  },
  {
    label: "体育",
    subcategories: [
      { label: "中国·荣耀", seeds: [
        { desc: "许海峰夺得首枚奥运金牌", fact: "1984年", word: "XuHaifeng", digits: "1984" },
        { desc: "刘翔雅典110米栏夺冠", fact: "2004年", word: "LiuXiang", digits: "2004" },
        { desc: "中国女排夺冠", fact: "1981年", word: "Volleyball", digits: "1981" },
        { desc: "北京奥运会", fact: "2008年", word: "Beijing", digits: "2008" },
      ]},
      { label: "世界·纪录", seeds: [
        { desc: "博尔特百米世界纪录", fact: "9.58秒", word: "Bolt", digits: "958" },
        { desc: "贝利世界杯夺冠", fact: "1970年", word: "Pele", digits: "1970" },
        { desc: "乔丹总决赛", fact: "1998年", word: "Jordan", digits: "1998" },
        { desc: "马拉松世界纪录", fact: "约2小时35秒", word: "Marathon", digits: "200" },
      ]},
    ],
  },
  {
    label: "科技",
    subcategories: [
      { label: "中国·成就", seeds: [
        { desc: "两弹一星", fact: "1964年", word: "Atomic", digits: "1964" },
        { desc: "天宫空间站", fact: "2021年", word: "Tiangong", digits: "2021" },
        { desc: "青蒿素发现", fact: "1972年", word: "Artemisinin", digits: "1972" },
        { desc: "中国高铁", fact: "2008年", word: "HSR", digits: "2008" },
      ]},
      { label: "世界·里程碑", seeds: [
        { desc: "万维网诞生", fact: "1989年", word: "WWW", digits: "1989" },
        { desc: "首台通用计算机 ENIAC", fact: "1945年", word: "ENIAC", digits: "1945" },
        { desc: "DNA双螺旋", fact: "1953年", word: "Helix", digits: "1953" },
        { desc: "人类基因组草图", fact: "2000年", word: "Genome", digits: "2000" },
      ]},
    ],
  },
  {
    label: "电影",
    subcategories: [
      { label: "中国·经典", seeds: [
        { desc: "《霸王别姬》上映", fact: "1993年", word: "Farewell", digits: "1993" },
        { desc: "《少林寺》上映", fact: "1982年", word: "Shaolin", digits: "1982" },
        { desc: "《卧虎藏龙》上映", fact: "2000年", word: "CrouchingTiger", digits: "2000" },
        { desc: "《大话西游》上映", fact: "1995年", word: "Westward", digits: "1995" },
      ]},
      { label: "世界·经典", seeds: [
        { desc: "《教父》上映", fact: "1972年", word: "Godfather", digits: "1972" },
        { desc: "《肖申克的救赎》上映", fact: "1994年", word: "Shawshank", digits: "1994" },
        { desc: "《泰坦尼克号》上映", fact: "1997年", word: "Titanic", digits: "1997" },
        { desc: "《星球大战》上映", fact: "1977年", word: "StarWars", digits: "1977" },
      ]},
    ],
  },
  {
    label: "数学常量",
    subcategories: [
      { label: "著名常数", seeds: [
        { desc: "黄金比例 φ", fact: "≈ 1.618", word: "Phi", digits: "1618" },
        { desc: "自然常数 e", fact: "≈ 2.718", word: "Euler", digits: "2718" },
        { desc: "√2", fact: "≈ 1.414", word: "SqrtTwo", digits: "1414" },
        { desc: "欧拉公式", fact: "e^iπ + 1 = 0", word: "EulerIdentity", digits: "1729" },
      ]},
      { label: "著名数列", seeds: [
        { desc: "斐波那契数列", fact: "1,1,2,3,5…", word: "Fibonacci", digits: "1123" },
        { desc: "质数序列", fact: "2,3,5,7…", word: "Prime", digits: "2357" },
        { desc: "完美数 28", fact: "≈ 6.283", word: "Tau", digits: "6283" },
      ]},
      { label: "自然数字", seeds: [
        { desc: "地球平均半径", fact: "6371公里", word: "Earth", digits: "6371" },
        { desc: "光速", fact: "299792 km/s", word: "Light", digits: "2997" },
        { desc: "太阳表面温度", fact: "约5500℃", word: "Sun", digits: "5500" },
      ]},
    ],
  },
]);

/** Tiny local fallback pool used when the model path fails (labelled as such). */
const FALLBACK_POOL = Object.freeze([
  { word: "Pi", digits: "3.14159265", note: "圆周率 π" },
  { word: "Euler", digits: "2.71828182", note: "自然常数 e" },
  { word: "Phi", digits: "1.61803398", note: "黄金比例 φ" },
  { word: "Sqrt2", digits: "1.41421356", note: "√2" },
  { word: "Fib", digits: "1123581321", note: "斐波那契数列" },
  { word: "Prime", digits: "2357111317", note: "质数序列" },
  { word: "Tau", digits: "6.28318530", note: "τ = 2π" },
]);

/* ── cryptographically secure randomness (rejection sampling, no bias) ── */
function secureRandomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) throw new Error("bad range");
  const range = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buf = new Uint32Array(1);
  let x;
  do {
    crypto.getRandomValues(buf);
    x = buf[0];
  } while (x >= range);
  return x % maxExclusive;
}

const pickChar = (set) => set[secureRandomInt(set.length)];

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = secureRandomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Mix the case of a word, guaranteeing at least one upper and one lower letter. */
function mixCase(word) {
  const out = [...word].map((ch) =>
    /[a-zA-Z]/.test(ch) ? (secureRandomInt(2) ? ch.toUpperCase() : ch.toLowerCase()) : ch,
  );
  const firstLetter = out.findIndex((ch) => /[a-zA-Z]/.test(ch));
  const lastLetter = out.findLastIndex((ch) => /[a-zA-Z]/.test(ch));
  if (firstLetter === -1) return word; // no letters: keep as-is (never happens in the pool)
  if (!out.some((ch) => /[A-Z]/.test(ch))) out[firstLetter] = out[firstLetter].toUpperCase();
  if (!out.some((ch) => /[a-z]/.test(ch))) out[lastLetter] = out[lastLetter].toLowerCase();
  return out.join("");
}

/**
 * Build a fallback password from one pool entry (word + digits + 1–2 symbols),
 * padded to exactly `length`. The word/digits are curated memorability content
 * (may include 0/1/… digits of the constant itself), so this is NOT run through
 * the strict LLM-output gate — the builder guarantees class coverage directly.
 */
function buildFallbackPassword(entry, length) {
  const word = mixCase(entry.word);
  const symbolRoom = length - word.length - 1; // keep ≥1 char for a symbol
  let digits = entry.digits;
  if (digits.length > Math.max(symbolRoom, 0)) digits = digits.slice(0, Math.max(symbolRoom, 0));
  const maxSymbols = Math.min(2, length - word.length - digits.length);
  const symbolCount = maxSymbols <= 0 ? 1 : 1 + secureRandomInt(Math.min(2, maxSymbols));
  const symbols = [];
  while (symbols.length < symbolCount) {
    const s = pickChar(SETS.symbol);
    if (!symbols.includes(s)) symbols.push(s);
  }
  const parts = [word, digits, symbols.join("")];
  const order = shuffle([0, 1, 2]);
  let pw = order.map((i) => parts[i]).join("");
  const pool = SETS.lower + SETS.upper + SETS.digit + SETS.symbol;
  while (pw.length < length) pw += pickChar(pool);
  return pw;
}

/* ── output validation ── */
function hasClass(pw, set) {
  for (const ch of pw) if (set.includes(ch)) return true;
  return false;
}

/**
 * A valid meaningful password: exactly `length` printable-ASCII chars with at
 * least one char of each of the four classes. Unlike the random tiers (which
 * are built from the confusable-free sets directly), the meaningful tier is
 * allowed to contain `0O1lI` — curated constants (π = 3.14159…) need them —
 * so the gate is structural, not alphabet-restricted.
 */
function validatePassword(pw, length) {
  if (typeof pw !== "string" || pw.length !== length) return false;
  for (const ch of pw) {
    const code = ch.codePointAt(0);
    if (code < 0x21 || code > 0x7e) return false; // printable ASCII only
  }
  return (
    /[a-z]/.test(pw) &&
    /[A-Z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    hasClass(pw, SETS.symbol)
  );
}

/** Strip surrounding quotes / whitespace the model may add despite the prompt. */
function sanitizeOutput(raw) {
  let s = String(raw).trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'") || (first === "`" && last === "`")) {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish) {
  switch (finish.kind) {
    case "stop":
      return undefined;
    case "error":
    case "aborted": {
      const error = new Error(finish.failure.message);
      error.code = finish.failure.code;
      return error;
    }
    case "max-tokens":
      return new Error("password-generator: model output reached the token limit");
    case "tool-calls":
      return new Error("password-generator: model unexpectedly requested a tool");
    default:
      return new Error(`password-generator: unsupported finish reason "${String(finish.kind)}"`);
  }
}

/* ── recent-seed dedup ──
 * Uniform random over the seed table still has a birthday-paradox baseline
 * (a repeated leaf is likely over a handful of draws). To drive short-window
 * repeats toward zero, `pickSeed` keeps a bounded in-process ring of recently
 * used leaf keys and rejection-samples a fresh path. This is TRANSIENT process
 * memory only: nothing is written to disk, a session, or any record, and the
 * ring resets on restart — it does not persist passwords, history, or state.
 */
const RECENT_WINDOW = 16;
const MAX_PICK_TRIES = 10;
const recentSeedKeys = [];

function randomLeaf() {
  const topic = TOPICS[secureRandomInt(TOPICS.length)];
  const subcategory = topic.subcategories[secureRandomInt(topic.subcategories.length)];
  const seed = subcategory.seeds[secureRandomInt(subcategory.seeds.length)];
  return { topic, subcategory, seed };
}

function leafKey(pick) {
  return `${pick.topic.label}|${pick.subcategory.label}|${pick.seed.desc}`;
}

/** Choose a random topic → subcategory → leaf seed, avoiding the most recent window. */
function pickSeed() {
  let pick = randomLeaf();
  for (let attempt = 0; attempt < MAX_PICK_TRIES; attempt++) {
    pick = randomLeaf();
    if (!recentSeedKeys.includes(leafKey(pick))) break;
  }
  recentSeedKeys.push(leafKey(pick));
  if (recentSeedKeys.length > RECENT_WINDOW) recentSeedKeys.shift();
  return pick;
}

function buildSystemPrompt(length, seed) {
  return [
    "You are a password suggestion tool. Generate ONE memorable password for a human user.",
    `The password must be exactly ${length} characters long.`,
    "It must contain at least one lowercase letter, one uppercase letter, one digit, and one symbol from !@#$%^&*()-_=+[]{};:,.<>?",
    `Base it on this fact: ${seed.desc} — ${seed.fact}.`,
    `Work the romanized keyword "${seed.word}" (in mixed upper/lowercase) and the key number "${seed.digits}" into the password, plus one or two symbols. The result must be short and memorable, evoking that fact.`,
    "Output ONLY the password itself on one line — no quotes, no spaces, no explanation, no newlines, no backticks.",
  ].join("\n");
}

/** One auxiliary LLM call: picks a random seed and asks the model to build a fresh password. */
async function callModel(ctx, length) {
  const selection = ctx.agentDefaultModel.currentSelection();
  const picked = pickSeed();
  const messages = [
    createUserMessage({
      content: [
        {
          type: "text",
          text: `Generate one memorable password with exactly ${length} characters.`,
        },
      ],
      source: { kind: "plugin", plugin: name },
    }),
  ];
  const options = {
    provider: selection.provider,
    model: selection.model,
    // A password is a plain-text auxiliary output: force thinking off so the
    // token budget goes to the password, not to a reasoning preamble, and the
    // finish reason is a clean `stop` instead of `max-tokens`.
    reasoningEffort: "off",
    messages,
    system: buildSystemPrompt(length, picked.seed),
    maxTokens: 96,
    temperature: 0.9,
    // Bound the call so a stalled provider cannot hang the smart tier; the
    // abort surfaces as a terminal `aborted` finish, caught by the fallback.
    signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
  };
  const assembler = new BlockAssembler();
  for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
  const terminal = finishError(assembler.finish);
  if (terminal !== undefined) throw terminal;
  const text = assembler
    .blocks()
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return { text, picked };
}

/**
 * Split the model's output: line 1 is the password, any trailing lines are
 * ignored (the provenance is determined by the seed, not the model). Returns
 * `passwordRaw` (line 1, trimmed).
 */
function splitModelOutput(raw) {
  const lines = String(raw)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return {
    passwordRaw: lines.length === 0 ? "" : lines[0],
    meaning: lines.slice(1).join(" ").trim(),
  };
}

/**
 * Accept one model response for the meaningful tier and bring it to exactly
 * `length` chars. The model often stops at a natural keyword break, so a
 * structurally valid output of 8..length chars is padded with random filler to
 * the target — the demo's documented "不足 16 位用随机字符补位收尾" behavior.
 * Returns null when the output is unusable.
 */
function normalizeMeaningful(raw, length) {
  const s = sanitizeOutput(raw);
  if (typeof s !== "string" || s.length < 8 || s.length > length) return null;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code < 0x21 || code > 0x7e) return null; // printable ASCII only
  }
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s) || !hasClass(s, SETS.symbol)) return null;
  if (s.length === length) return s;
  // Filler is random, so it uses the confusable-free pool; the meaningful core
  // keeps its own digits.
  const pool = SETS.lower + SETS.upper + SETS.digit + SETS.symbol;
  let pw = s;
  while (pw.length < length) pw += pickChar(pool);
  return pw;
}

function normalizeLength(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_LENGTH || value > MAX_LENGTH) return SMART_LENGTH;
  return value;
}

/**
 * Generate one meaningful password through the default model, with validation
 * retries and a labelled local-pool fallback.
 * @param request - `{ length?: number }`; length defaults to 16 and is clamped.
 * @returns `{ password, note }` — the password plus a human-readable provenance line.
 */
async function generateMeaningful(request) {
  const length = normalizeLength(request?.length);
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const { text: raw, picked } = await callModel(this.ctx, length);
      const { passwordRaw } = splitModelOutput(raw);
      const password = normalizeMeaningful(passwordRaw, length);
      if (password !== null) {
        return {
          password,
          note: `${picked.topic.label} · ${picked.subcategory.label} · ${picked.seed.desc} · ${picked.seed.fact}`,
        };
      }
      lastError = new Error(`password-generator: model output failed validation (attempt ${attempt}/${MAX_ATTEMPTS})`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  // Fallback: never fail the user outright; label the provenance instead.
  const entry = FALLBACK_POOL[secureRandomInt(FALLBACK_POOL.length)];
  return {
    password: buildFallbackPassword(entry, length),
    note: `本地词库兜底 · ${entry.note}`,
  };
}

/**
 * The `passwordGenerator` Remote service. Constructing it (as a cordis class
 * plugin) provides the service under that key and binds it to the Typert
 * Gateway, so the browser half can call `ctx.remote.passwordGenerator.*`.
 */
class PasswordGeneratorRuntime extends TypertRemoteService {
  static inject = ["llm", "agentDefaultModel"];

  constructor(ctx) {
    super(ctx, "passwordGenerator");
    for (const initializer of PASSWORD_GENERATOR_INITIALIZERS) initializer.call(this);
  }

  async generateMeaningful(request) {
    return generateMeaningful.call(this, request);
  }
}

/* ── Remote marker registration ──
 *
 * The `@Remote` decorator is a standard (TC39) method decorator; this package
 * is shipped as plain JavaScript, so the equivalent marker registration is
 * applied manually through the public `Remote` function with a synthetic
 * decorator context. The initializer runs once per instance and records the
 * method in the typert-protocol marker table that the gateway reads.
 */
const PASSWORD_GENERATOR_INITIALIZERS = [];
Remote(PasswordGeneratorRuntime.prototype.generateMeaningful, {
  kind: "method",
  name: "generateMeaningful",
  private: false,
  static: false,
  addInitializer(initializer) {
    PASSWORD_GENERATOR_INITIALIZERS.push(initializer);
  },
});

export {
  PasswordGeneratorRuntime,
  generateMeaningful,
  validatePassword,
  normalizeMeaningful,
  splitModelOutput,
  pickSeed,
  buildFallbackPassword,
  normalizeLength,
};
export default PasswordGeneratorRuntime;
