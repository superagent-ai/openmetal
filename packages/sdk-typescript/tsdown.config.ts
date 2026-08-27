import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  tsconfig: "tsconfig.npm.json",
  outDir: "dist/npm",
  clean: true,
  format: ["esm"],
  platform: "neutral",
  target: "es2022",
  dts: {
    resolver: "tsc",
    tsconfig: "tsconfig.npm.json",
  },
  minify: true,
  sourcemap: false,
  treeshake: true,
  deps: {
    alwaysBundle: [/^@openmetal\/contracts$/],
    neverBundle: [/^zod(?:\/|$)/],
  },
  inputOptions: {
    resolve: {
      mainFields: ["module", "main"],
    },
  },
});
