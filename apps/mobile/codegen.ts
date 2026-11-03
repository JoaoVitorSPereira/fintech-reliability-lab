import type { CodegenConfig } from '@graphql-codegen/cli';

// Types come from the API's committed SDL, so client and server can't drift
// silently: CI regenerates and fails on a diff.
const config: CodegenConfig = {
  schema: '../api/schema.graphql',
  documents: ['src/**/*.{ts,tsx}', '!src/graphql/generated/**'],
  ignoreNoDocuments: true,
  generates: {
    './src/graphql/generated/': {
      preset: 'client',
      presetConfig: { fragmentMasking: false },
      config: { scalars: { DateTime: 'string', Decimal: 'string' }, useTypeImports: true, enumsAsTypes: true, nonOptionalTypename: true },
    },
  },
};

export default config;
