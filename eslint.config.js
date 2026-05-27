import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typedConfigs = tseslint.configs.strictTypeChecked.map((config) => ({
  ...config,
  files: ["**/*.ts"]
}));

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".wrangler/**", ".auth/**"]
  },
  js.configs.recommended,
  ...typedConfigs,
  {
    files: ["**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "no-undef": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowAny: false,
          allowBoolean: true,
          allowNever: false,
          allowNullish: false,
          allowNumber: true,
          allowRegExp: true
        }
      ]
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/require-await": "off"
    }
  },
  {
    files: ["worker/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.serviceworker
      }
    }
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node
      }
    }
  }
);
