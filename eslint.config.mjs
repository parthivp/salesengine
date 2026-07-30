import next from 'eslint-config-next'
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals'
import nextTypescript from 'eslint-config-next/typescript'

/**
 * Flat config. There was no eslint config file in this project at all, and the
 * `lint` script still ran `next lint` — removed in Next 16, which interpreted the
 * word "lint" as a directory and failed with "no such directory: ./lint". So the
 * linter had never actually run. `npm run lint` now runs eslint directly.
 */
const config = [
  ...next,
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'next-env.d.ts',
      'extension/**', // plain browser scripts, no module system, linted by hand
    ],
  },
  {
    rules: {
      // The Prisma JSON columns genuinely have no static type, and the alternative
      // at each site is a hand-written cast that claims more than it knows.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // `const { attributes, ...rest } = record` is how you omit a key. The
          // binding is unused by design — that is the whole point of writing it.
          ignoreRestSiblings: true,
        },
      ],
    },
  },
]

export default config
