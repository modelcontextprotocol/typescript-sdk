import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/**/*.ts', '!src/**/*.test.ts', '!src/__mocks__/**', '!src/examples/**'],
  format: ['esm', 'cjs'],
  outDir: 'dist',
  target: 'es2018',
  dts: true,
  shims: true,
  platform: 'node',
});
