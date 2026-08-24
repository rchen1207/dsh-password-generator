/**
 * tsdown build config for dsh-client-ui-password-generator.
 *
 * This is the canonical upstream-style build for DSH client packages (the
 * same shape `dsh-client-ui-*` packages use): it emits the ESM host half and
 * the DSH lazy-CJS browser bundle (`window.__ModuleLoader__.load`), with the
 * browser externals resolved against the shell's static module table.
 *
 * The monorepo toolchain is not required to build this package: `scripts/
 * build.mjs` produces the same `lib/` artifacts with plain Node, so the
 * checked-in bundles stay rebuildable in this standalone workspace. When the
 * full toolchain is available, `pnpm bundle` (tsdown) is the preferred path.
 */
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/host/index.ts",
    client: "src/client/index.ts",
  },
  format: ["esm"],
  platform: "node",
  target: "node20",
  dts: false,
  external: [
    // host half
    "@deepseek-ai/cordis",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-typert-protocol",
    "@deepseek-ai/dsh-agent-default-model",
    // browser half — the shell's static module table
    "react",
    "react/jsx-runtime",
    "@deepseek-ai/dsh-client-ui-primitives",
    "@deepseek-ai/dsh-client-ui-slots",
    "@deepseek-ai/dsh-client-runtime",
    "@deepseek-ai/dsh-client-locale",
    "@deepseek-ai/dsh-api-remotes",
  ],
});
