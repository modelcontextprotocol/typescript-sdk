import baseConfig from '@modelcontextprotocol/vitest-config';
import { mergeConfig } from 'vitest/config';

export default mergeConfig(baseConfig, {
    test: {
        setupFiles: ['./vitest.setup.js']
    }
});
