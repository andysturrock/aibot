// @ts-check

import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ["packages/*/dist/", "packages/*/node_modules/", "packages/*/cdk.out"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.recommendedTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.json', './packages/*/tsconfig.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/semi": ["error"],
      "@typescript-eslint/consistent-type-definitions": [
        "error",
        "type"
      ],
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: true,
          allowRegExp: true
        },
      ],
    }
  }
);