/**
 * Build script for dsh-client-ui-password-generator.
 *
 * Produces the two artifacts the DSH loader consumes, without needing the
 * monorepo toolchain:
 *
 *   lib/index.js   — host half. Plain ESM (package "type": "module"); the
 *                    cordis loader imports the package `main` directly, so the
 *                    source is copied verbatim.
 *   lib/client.js  — browser half. Wrapped in the DSH lazy-CJS bundle format
 *                    (`window.__ModuleLoader__.load({ id, factory })`) that
 *                    `dsh-client-modules` serves at /plugins/<id>/client.js.
 *                    The wrapper provides the `_react` and `_primitives`
 *                    factory locals that src/client/index.js consumes.
 *
 * The canonical upstream build is tsdown (see tsdown.config.ts); this script
 * exists so the package can be rebuilt without installing that toolchain, and
 * must keep producing byte-compatible-enough output for the loader.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_ID = "dsh-client-ui-password-generator";

const hostSource = readFileSync(join(ROOT, "src/host/index.js"), "utf8");
const clientSource = readFileSync(join(ROOT, "src/client/index.js"), "utf8");

mkdirSync(join(ROOT, "lib"), { recursive: true });

// Host half: verbatim copy.
writeFileSync(join(ROOT, "lib/index.js"), hostSource);

// Client half: lazy-CJS bundle wrapper.
const clientBundle = [
  `window.__ModuleLoader__.load({`,
  `\tid: ${JSON.stringify(PKG_ID)},`,
  `\tfactory: (require) => {`,
  `\t\tvar module = { exports: {} };`,
  `\t\tvar exports = module.exports;`,
  `\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });`,
  `\t\tlet _react = require("react");`,
  `\t\tlet _primitives = require("@deepseek-ai/dsh-client-ui-primitives");`,
  clientSource.split("\n").map((line) => `\t\t${line}`).join("\n"),
  `\t\treturn module.exports;`,
  `\t}`,
  `});`,
  ``,
].join("\n");

writeFileSync(join(ROOT, "lib/client.js"), clientBundle);

console.log("built lib/index.js and lib/client.js");
