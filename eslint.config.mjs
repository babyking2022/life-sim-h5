import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", "**/.artifacts/**", "**/dist/**", "**/coverage/**"]
  },
  ...tseslint.configs.recommended,
  {
    files: ["packages/engine/src/**/*.ts"],
    rules: {
      "no-restricted-globals": [
        "error",
        "window",
        "document",
        "localStorage",
        "sessionStorage",
        "indexedDB",
        "navigator",
        "fetch",
        "crypto"
      ],
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "engine RNG must be deterministic" },
        { object: "Date", property: "now", message: "engine must not read wall clock" },
        { object: "performance", property: "now", message: "engine must not read wall clock" },
        { object: "crypto", property: "getRandomValues", message: "engine must not use nondeterministic crypto" },
        { object: "crypto", property: "randomUUID", message: "engine must not use nondeterministic crypto" },
        { object: "crypto", property: "randomBytes", message: "engine must not use nondeterministic crypto" }
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: ["react", "react-dom", "@life-sim/save", "crypto", "node:crypto"],
          patterns: [
            "react/*",
            "react-dom/*",
            "@life-sim/save/*",
            "crypto/*",
            "node:crypto/*",
            "**/save",
            "**/save/*"
          ]
        }
      ]
    }
  }
);
