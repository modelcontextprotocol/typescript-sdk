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

    test('reflects current peer settings on each call (no caching across reconnects)', () => {
        let peer: JSONObject | undefined;
        const getter = vi.fn(() => peer);
        const host = makeMockHost() as unknown as ExtensionHost<BaseContext>;
        const handle = new ExtensionHandle(host, 'io.example/ui', {}, getter, false);

        expect(handle.getPeerSettings()).toBeUndefined();
        peer = { v: 1 };
        expect(handle.getPeerSettings()).toEqual({ v: 1 });
        peer = { v: 2 };
        expect(handle.getPeerSettings()).toEqual({ v: 2 });
        peer = undefined;
        expect(handle.getPeerSettings()).toBeUndefined();
        expect(getter).toHaveBeenCalledTimes(4);
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

    test('strict mode: rejects with CapabilityNotSupported when peer did not advertise', async () => {
        const { host, handle } = makeHandle({ peer: undefined, strict: true });
        await expect(handle.sendRequest('ui/do', {}, Result)).rejects.toSatisfy(
            (e: unknown) =>
                e instanceof SdkError && e.code === SdkErrorCode.CapabilityNotSupported && /io\.example\/ui.*ui\/do/.test(e.message)
        );
        expect(host.sendCustomRequest).not.toHaveBeenCalled();
        await expect(handle.sendNotification('ui/ping')).rejects.toSatisfy(
            (e: unknown) => e instanceof SdkError && e.code === SdkErrorCode.CapabilityNotSupported
        );
        expect(host.sendCustomNotification).not.toHaveBeenCalled();
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
