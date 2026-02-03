import { platform, release } from 'node:os';
import { versions } from 'node:process';

import packageJson from '../../package.json' with { type: 'json' };
import { createUserAgentProvider } from './userAgent.js';

// Type for mocking window in tests
type MockWindow = { navigator?: { userAgent?: string } };

// Augment globalThis for test mocking
declare global {
    // eslint-disable-next-line no-var
    var window: MockWindow | undefined;
}

describe('createUserAgent', () => {
    describe('browser', () => {
        let windowOriginal: MockWindow | undefined;

        beforeEach(() => {
            windowOriginal = globalThis.window;
            globalThis.window = {
                navigator: {
                    get userAgent() {
                        return 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
                    }
                }
            };
        });

        afterEach(async () => {
            globalThis.window = windowOriginal;
        });

        it('should generate user agent in a browser environment', async () => {
            const ua = await createUserAgentProvider()();
            expect(ua).toBe(`mcp-sdk-ts/${packageJson.version} os/macOS#10.15.7 lang/js`);
        });
    });

    describe('Node', () => {
        it('should generate user agent in a Node environment', async () => {
            const ua = await createUserAgentProvider()();
            expect(ua).toBe(`mcp-sdk-ts/${packageJson.version} os/${platform()}#${release()} lang/js md/nodejs#${versions.node}`);
        });
    });
});
