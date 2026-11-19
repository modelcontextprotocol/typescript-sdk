import type { OAuthClientMetadata, SdkLogger, StoredOAuthClientInformation } from '@modelcontextprotocol/core-internal';
import { createMockOAuthFetch } from '@modelcontextprotocol/test-helpers';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type { OAuthClientProvider } from '../../src/client/auth';
import { auth } from '../../src/client/auth';

const RESOURCE_SERVER_URL = 'https://resource.example.com/';
const AUTH_SERVER_URL = 'https://auth.example.com';

// Copied from winston 3.19 `index.d.ts` (`LeveledLogMethod`).
interface WinstonLeveledLogMethod {
    (message: string, ...meta: any[]): WinstonLogger;
    (message: any): WinstonLogger;
    (infoObject: object): WinstonLogger;
}
interface WinstonLogger {
    debug: WinstonLeveledLogMethod;
    info: WinstonLeveledLogMethod;
    warn: WinstonLeveledLogMethod;
    error: WinstonLeveledLogMethod;
}

// pino's classic `LogFn` overloads (pino 10 narrows `args` from the message template).
interface PinoLogFn {
    (obj: object, msg?: string, ...args: any[]): void;
    (msg: string, ...args: any[]): void;
}
interface PinoLogger {
    debug: PinoLogFn;
    info: PinoLogFn;
    warn: PinoLogFn;
    error: PinoLogFn;
}

// A provider whose unstamped client information makes auth() print a warning.
abstract class WarningProvider implements OAuthClientProvider {
    readonly redirectUrl = 'http://localhost:3000/callback';
    readonly clientMetadata: OAuthClientMetadata = { redirect_uris: ['http://localhost:3000/callback'] };
    clientInformation(): StoredOAuthClientInformation {
        return { client_id: 'cid' };
    }
    saveClientInformation(): void {}
    tokens(): undefined {
        return undefined;
    }
    saveTokens(): void {}
    redirectToAuthorization(): void {}
    saveCodeVerifier(): void {}
    codeVerifier(): string {
        return 'verifier';
    }
}

const warnSpy = () => vi.fn<(...args: unknown[]) => void>();

class WinstonProvider extends WarningProvider {
    readonly warn = warnSpy();
    logger: WinstonLogger = { debug: vi.fn(), info: vi.fn(), warn: this.warn, error: vi.fn() } as unknown as WinstonLogger;
}
class PinoProvider extends WarningProvider {
    readonly warn = warnSpy();
    logger: PinoLogger = { debug: vi.fn(), info: vi.fn(), warn: this.warn, error: vi.fn() };
}
class LogOnlyProvider extends WarningProvider {
    readonly warn = warnSpy();
    logger = { log: this.warn };
}
class FunctionProvider extends WarningProvider {
    readonly warn = warnSpy();
    logger = (message: string): void => this.warn(message);
}

describe('OAuthClientProvider sdkLogger', () => {
    it('leaves a `logger` property of any shape on an implementing class alone at the type level', () => {
        expectTypeOf<WinstonProvider>().toExtend<OAuthClientProvider>();
        expectTypeOf<PinoProvider>().toExtend<OAuthClientProvider>();
        expectTypeOf<LogOnlyProvider>().toExtend<OAuthClientProvider>();
        expectTypeOf<FunctionProvider>().toExtend<OAuthClientProvider>();
    });

    it('accepts winston- and pino-shaped loggers as sdkLogger', () => {
        expectTypeOf<WinstonLogger>().toExtend<SdkLogger>();
        expectTypeOf<PinoLogger>().toExtend<SdkLogger>();
        expectTypeOf<Console>().toExtend<SdkLogger>();
    });

    it.each([
        ['winston-style', () => new WinstonProvider()],
        ['pino-style', () => new PinoProvider()],
        ['log()-only', () => new LogOnlyProvider()],
        ['plain function', () => new FunctionProvider()]
    ])('never writes to a %s `logger` the implementing class already has', async (_name, create) => {
        const provider = create();
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fetchFn = createMockOAuthFetch({ resourceServerUrl: RESOURCE_SERVER_URL, authServerUrl: AUTH_SERVER_URL });

        try {
            await auth(provider, { serverUrl: RESOURCE_SERVER_URL, fetchFn });
            expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining("no 'issuer' stamp"));
            expect(provider.warn).not.toHaveBeenCalled();
        } finally {
            consoleWarn.mockRestore();
        }
    });

    it('writes to sdkLogger when the class sets it', async () => {
        const provider = new PinoProvider();
        const sdkWarn = warnSpy();
        const withSdkLogger: OAuthClientProvider = Object.assign(provider, { sdkLogger: { warn: sdkWarn } });
        const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const fetchFn = createMockOAuthFetch({ resourceServerUrl: RESOURCE_SERVER_URL, authServerUrl: AUTH_SERVER_URL });

        try {
            await auth(withSdkLogger, { serverUrl: RESOURCE_SERVER_URL, fetchFn });
            expect(sdkWarn).toHaveBeenCalledWith(expect.stringContaining("no 'issuer' stamp"));
            expect(provider.warn).not.toHaveBeenCalled();
            expect(consoleWarn).not.toHaveBeenCalled();
        } finally {
            consoleWarn.mockRestore();
        }
    });
});
