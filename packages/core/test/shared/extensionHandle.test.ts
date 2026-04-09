import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod/v4';

import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import type { ExtensionHost } from '../../src/shared/extensionHandle.js';
import { ExtensionHandle } from '../../src/shared/extensionHandle.js';
import type { BaseContext } from '../../src/shared/protocol.js';
import type { JSONObject } from '../../src/types/types.js';

type MockHost = {
    setCustomRequestHandler: ReturnType<typeof vi.fn>;
    setCustomNotificationHandler: ReturnType<typeof vi.fn>;
    sendCustomRequest: ReturnType<typeof vi.fn>;
    sendCustomNotification: ReturnType<typeof vi.fn>;
};

function makeMockHost(): MockHost {
    return {
        setCustomRequestHandler: vi.fn(),
        setCustomNotificationHandler: vi.fn(),
        sendCustomRequest: vi.fn().mockResolvedValue({ ok: true }),
        sendCustomNotification: vi.fn().mockResolvedValue(undefined)
    };
}

function makeHandle(opts: { peer?: JSONObject | undefined; strict?: boolean; peerSchema?: z.core.$ZodType }): {
    host: MockHost;
    handle: ExtensionHandle<JSONObject, unknown, BaseContext>;
} {
    const host = makeMockHost();
    const handle = new ExtensionHandle(
        host as unknown as ExtensionHost<BaseContext>,
        'io.example/ui',
        { local: true },
        () => opts.peer,
        opts.strict ?? false,
        opts.peerSchema
    );
    return { host, handle };
}

describe('ExtensionHandle.getPeerSettings', () => {
    test('returns raw blob when no peerSchema given', () => {
        const { handle } = makeHandle({ peer: { feature: 'x' } });
        expect(handle.getPeerSettings()).toEqual({ feature: 'x' });
    });

    test('returns undefined when peer did not advertise', () => {
        const { handle } = makeHandle({ peer: undefined });
        expect(handle.getPeerSettings()).toBeUndefined();
    });

    test('parses and returns typed value when peerSchema matches', () => {
        const PeerSchema = z.object({ openLinks: z.boolean(), maxSize: z.number() });
        const { handle } = makeHandle({ peer: { openLinks: true, maxSize: 5 }, peerSchema: PeerSchema });
        expect(handle.getPeerSettings()).toEqual({ openLinks: true, maxSize: 5 });
    });

    test('returns undefined and warns when peerSchema does not match', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const PeerSchema = z.object({ openLinks: z.boolean() });
        const { handle } = makeHandle({ peer: { openLinks: 'yes' }, peerSchema: PeerSchema });
        expect(handle.getPeerSettings()).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]?.[0]).toMatch(/io\.example\/ui.*failed schema validation/);
        warn.mockRestore();
    });

    test('caches the parsed result once peer has advertised', () => {
        const getter = vi.fn().mockReturnValue({ a: 1 });
        const host = makeMockHost() as unknown as ExtensionHost<BaseContext>;
        const handle = new ExtensionHandle(host, 'io.example/ui', {}, getter, false);
        handle.getPeerSettings();
        handle.getPeerSettings();
        handle.getPeerSettings();
        expect(getter).toHaveBeenCalledTimes(1);
    });

    test('does not cache undefined (so a later-connecting peer is observable)', () => {
        let peer: JSONObject | undefined;
        const getter = vi.fn(() => peer);
        const host = makeMockHost() as unknown as ExtensionHost<BaseContext>;
        const handle = new ExtensionHandle(host, 'io.example/ui', {}, getter, false);
        expect(handle.getPeerSettings()).toBeUndefined();
        peer = { now: 'connected' };
        expect(handle.getPeerSettings()).toEqual({ now: 'connected' });
        expect(handle.getPeerSettings()).toEqual({ now: 'connected' });
        expect(getter).toHaveBeenCalledTimes(2);
    });
});

describe('ExtensionHandle.setRequestHandler / setNotificationHandler', () => {
    test('delegates to host setCustom* (anytime)', () => {
        const { host, handle } = makeHandle({ peer: undefined });
        const params = z.object({ q: z.string() });
        const reqHandler = vi.fn();
        const notifHandler = vi.fn();

        handle.setRequestHandler('ui/search', params, reqHandler);
        expect(host.setCustomRequestHandler).toHaveBeenCalledWith('ui/search', params, reqHandler);

        handle.setNotificationHandler('ui/ping', params, notifHandler);
        expect(host.setCustomNotificationHandler).toHaveBeenCalledWith('ui/ping', params, notifHandler);
    });
});

describe('ExtensionHandle.sendRequest / sendNotification — peer gating', () => {
    const Result = z.object({ ok: z.boolean() });

    test('lax mode (default): sends even when peer did not advertise', async () => {
        const { host, handle } = makeHandle({ peer: undefined, strict: false });
        await handle.sendRequest('ui/do', { x: 1 }, Result);
        expect(host.sendCustomRequest).toHaveBeenCalledWith('ui/do', { x: 1 }, Result, undefined);
        await handle.sendNotification('ui/ping', {});
        expect(host.sendCustomNotification).toHaveBeenCalledWith('ui/ping', {}, undefined);
    });

    test('strict mode: throws CapabilityNotSupported when peer did not advertise', () => {
        const { host, handle } = makeHandle({ peer: undefined, strict: true });
        let thrown: unknown;
        try {
            void handle.sendRequest('ui/do', {}, Result);
        } catch (e) {
            thrown = e;
        }
        expect(thrown).toBeInstanceOf(SdkError);
        expect((thrown as SdkError).code).toBe(SdkErrorCode.CapabilityNotSupported);
        expect((thrown as SdkError).message).toMatch(/io\.example\/ui.*ui\/do/);
        expect(host.sendCustomRequest).not.toHaveBeenCalled();
        expect(() => handle.sendNotification('ui/ping')).toThrow(SdkError);
    });

    test('strict mode: sends when peer did advertise', async () => {
        const { host, handle } = makeHandle({ peer: { ok: true }, strict: true });
        await handle.sendRequest('ui/do', {}, Result);
        expect(host.sendCustomRequest).toHaveBeenCalledTimes(1);
        await handle.sendNotification('ui/ping');
        expect(host.sendCustomNotification).toHaveBeenCalledTimes(1);
    });
});

describe('ExtensionHandle — id and settings', () => {
    test('exposes id and local settings as readonly fields', () => {
        const { handle } = makeHandle({ peer: undefined });
        expect(handle.id).toBe('io.example/ui');
        expect(handle.settings).toEqual({ local: true });
    });
});
