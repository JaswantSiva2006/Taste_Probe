import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  // Local agent settings and QA evidence are git-ignored and not release source.
  globalIgnores([".next/**", "out/**", "build/**", "coverage/**", "next-env.d.ts", ".claude/**", ".agents/**", ".artifacts/**", ".probe/**"]),
]);
