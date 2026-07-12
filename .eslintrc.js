module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended'
  ],
  env: {
    node: true
  },
  rules: {
    '@typescript-eslint/no-explicit-any': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { 'argsIgnorePattern': '^_', 'varsIgnorePattern': '^_' }],
    'no-empty': ['error', { 'allowEmptyCatch': true }]
  },
  overrides: [
    {
      files: ['apps/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          paths: [
            { name: '@repo-xray/core', message: 'Apps must import through @repo-xray/sdk.' },
            { name: '@repo-xray/shared', message: 'Apps must import through @repo-xray/sdk.' },
            { name: '@repo-xray/storage', message: 'Apps must import through @repo-xray/sdk.' },
            { name: '@repo-xray/types', message: 'Apps must import through @repo-xray/sdk.' },
            { name: '@repo-xray/cache', message: 'Apps must import through @repo-xray/sdk.' }
          ]
        }]
      }
    },
    {
      files: ['packages/**/*.ts'],
      excludedFiles: ['packages/sdk/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          paths: [
            { name: '@repo-xray/cli', message: 'Packages cannot depend on apps.' },
            { name: '@repo-xray/web', message: 'Packages cannot depend on apps.' },
            { name: '@repo-xray/sdk', message: 'Packages cannot depend on the SDK layer.' }
          ]
        }]
      }
    },
    {
      files: ['shared/**/*.ts'],
      rules: {
        'no-restricted-imports': ['error', {
          patterns: ['@repo-xray/*']
        }]
      }
    }
  ]
};
