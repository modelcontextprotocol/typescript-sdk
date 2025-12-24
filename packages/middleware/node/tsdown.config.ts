import { defineConfig } from 'tsdown';

export default defineConfig({
    entry: ['src/index.ts'],
    outDir: 'dist',
    format: 'esm',
    clean: true,
    dts: true,
    sourcemap: true,
    external: ['@modelcontextprotocol/server', '@modelcontextprotocol/core']
});
