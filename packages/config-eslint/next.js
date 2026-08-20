import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import base from "./base.js";

export default [
  ...base,
  ...nextVitals,
  ...nextTs,
  {
    settings: {
      react: {
        version: "19.2.8",
      },
    },
    ignores: [".next/**", "out/**", "build/**", "next-env.d.ts"],
  },
];
