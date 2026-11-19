import { describe, expect, it } from 'vitest';

import {
    generateWebhookId,
    generateWebhookSecret,
    parseWebhookSecret,
    signWebhook,
    timingSafeEqualString,
    verifyWebhookSignature
} from '../../../src/ext/events/webhookSignature';

const bytesOf = (length: number): string => btoa('x'.repeat(length));

describe('Standard Webhooks signing', () => {
    it('reproduces the Standard Webhooks reference vector', async () => {
        const secret = parseWebhookSecret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')!;
        expect(secret.length).toBe(24);
        expect(await signWebhook([secret], 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}')).toBe(
            'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
        );
        expect(
            await verifyWebhookSignature(
                [secret],
                'msg_p5jXN8AQM9LWM0D4loKWxJek',
                1614265330,
                '{"test": 2432232314}',
                'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
            )
        ).toBe(true);
    });

    it('signs once per secret during rotation; either verifies, a re-serialized body does not', async () => {
        const secret = parseWebhookSecret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')!;
        const other = parseWebhookSecret(generateWebhookSecret())!;
        const header = await signWebhook([secret, other], 'msg_x', 1, '{"a": 1}');
        expect(header.split(' ')).toHaveLength(2);
        expect(await verifyWebhookSignature([secret], 'msg_x', 1, '{"a": 1}', header)).toBe(true);
        expect(await verifyWebhookSignature([other], 'msg_x', 1, '{"a": 1}', header)).toBe(true);
        expect(await verifyWebhookSignature([other], 'msg_x', 1, '{"a":1}', header)).toBe(false);
    });

    it('binds the id and timestamp, and ignores entries that are not v1', async () => {
        const secret = parseWebhookSecret(generateWebhookSecret())!;
        const header = await signWebhook([secret], 'msg_x', 1, '{}');
        const signature = header.slice('v1,'.length);
        expect(await verifyWebhookSignature([secret], 'msg_y', 1, '{}', header)).toBe(false);
        expect(await verifyWebhookSignature([secret], 'msg_x', 2, '{}', header)).toBe(false);
        expect(await verifyWebhookSignature([secret], 'msg_x', 1, '{}', `v1a,${signature}  junk ${header}`)).toBe(true);
        expect(await verifyWebhookSignature([secret], 'msg_x', 1, '{}', `v2,${signature}`)).toBe(false);
        expect(await verifyWebhookSignature([secret], 'msg_x', 1, '{}', signature)).toBe(false);
        expect(await verifyWebhookSignature([], 'msg_x', 1, '{}', header)).toBe(false);
    });
});

describe('parseWebhookSecret', () => {
    it('accepts whsec_ and padded base64 of 24 to 64 bytes', () => {
        expect(parseWebhookSecret(`whsec_${bytesOf(24)}`)?.length).toBe(24);
        expect(parseWebhookSecret(`whsec_${bytesOf(25)}`)?.length).toBe(25);
        expect(parseWebhookSecret(`whsec_${bytesOf(64)}`)?.length).toBe(64);
    });

    it('rejects anything else', () => {
        expect(parseWebhookSecret(`whsec_${bytesOf(23)}`)).toBeUndefined();
        expect(parseWebhookSecret(`whsec_${bytesOf(65)}`)).toBeUndefined();
        expect(parseWebhookSecret(bytesOf(32))).toBeUndefined();
        expect(parseWebhookSecret('whsec_***')).toBeUndefined();
        expect(parseWebhookSecret(`whsec_${bytesOf(25).replace(/=+$/, '')}`)).toBeUndefined();
        expect(parseWebhookSecret(`whsec_ ${bytesOf(32)}`)).toBeUndefined();
        expect(parseWebhookSecret(`whsec_${'-_'.repeat(16)}`)).toBeUndefined();
    });
});

describe('generators', () => {
    it('generates a whsec_ secret of 32 random bytes', () => {
        const secret = generateWebhookSecret();
        expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
        expect(parseWebhookSecret(secret)?.length).toBe(32);
        expect(generateWebhookSecret()).not.toBe(secret);
    });

    it('generates header-safe webhook ids, typed for control bodies', () => {
        expect(generateWebhookId()).toMatch(/^msg_[A-Za-z0-9_-]{22}$/);
        expect(generateWebhookId('gap')).toMatch(/^msg_gap_[A-Za-z0-9_-]{22}$/);
        expect(generateWebhookId('terminated')).toMatch(/^msg_terminated_[A-Za-z0-9_-]{22}$/);
        expect(generateWebhookId('verification')).toMatch(/^msg_verification_[A-Za-z0-9_-]{22}$/);
        expect(generateWebhookId()).not.toBe(generateWebhookId());
    });
});

describe('timingSafeEqualString', () => {
    it('is true only for identical strings', () => {
        expect(timingSafeEqualString('', '')).toBe(true);
        expect(timingSafeEqualString('v1,abc', 'v1,abc')).toBe(true);
        expect(timingSafeEqualString('v1,abc', 'v1,abd')).toBe(false);
        expect(timingSafeEqualString('v1,abc', 'v1,ab')).toBe(false);
        expect(timingSafeEqualString('😀', '😁')).toBe(false);
    });
});
