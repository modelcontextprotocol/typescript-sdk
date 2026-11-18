import { describe, expect, it } from 'vitest';

import { isSpecialPurposeAddress } from '../../../src/ext/events/specialAddresses';

describe('isSpecialPurposeAddress', () => {
    it.each([
        '127.0.0.1',
        '10.1.2.3',
        '169.254.169.254',
        '192.168.1.1',
        '100.64.0.1',
        '::1',
        'fe80::1',
        'fd00::1',
        '::ffff:127.0.0.1',
        '2001:db8::1'
    ])('flags %s', ip => {
        expect(isSpecialPurposeAddress(ip)).toBe(true);
    });

    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('allows %s', ip => expect(isSpecialPurposeAddress(ip)).toBe(false));

    it.each([
        ['0.0.0.0/8', '0.255.255.255'],
        ['10.0.0.0/8', '10.255.255.255'],
        ['100.64.0.0/10', '100.127.255.255'],
        ['127.0.0.0/8', '127.255.255.255'],
        ['169.254.0.0/16', '169.254.0.0'],
        ['172.16.0.0/12', '172.31.255.255'],
        ['192.0.0.0/24', '192.0.0.255'],
        ['192.0.2.0/24', '192.0.2.1'],
        ['192.88.99.0/24', '192.88.99.1'],
        ['192.168.0.0/16', '192.168.255.255'],
        ['198.18.0.0/15', '198.19.255.255'],
        ['198.51.100.0/24', '198.51.100.1'],
        ['203.0.113.0/24', '203.0.113.1'],
        ['224.0.0.0/4', '239.255.255.255'],
        ['240.0.0.0/4', '255.255.255.255'],
        ['::/128', '::'],
        ['::1/128', '0:0:0:0:0:0:0:1'],
        ['64:ff9b::/96 by its IPv4 part', '64:ff9b::a00:1'],
        ['64:ff9b::/96 by its IPv4 part', '64:ff9b::127.0.0.1'],
        ['64:ff9b:1::/48', '64:ff9b:1:ffff::1'],
        ['100::/64', '100::ffff:ffff:ffff:ffff'],
        ['2001::/23', '2001:1ff::1'],
        ['2001:db8::/32', '2001:DB8:ffff::1'],
        ['2002::/16', '2002:c000:204::1'],
        ['3fff::/20', '3fff:fff:ffff::1'],
        ['5f00::/16', '5f00:ffff::1'],
        ['fc00::/7', 'fdff::1'],
        ['fe80::/10', 'febf::1'],
        ['ff00::/8', 'ff02::1'],
        ['::ffff:0:0/96 by its IPv4 part', '::ffff:a00:1'],
        ['a zone id', 'fe80::1%lo0']
    ])('flags an address in %s (%s)', (_range, ip) => {
        expect(isSpecialPurposeAddress(ip)).toBe(true);
    });

    it.each([
        '9.255.255.255',
        '11.0.0.0',
        '100.128.0.0',
        '172.15.255.255',
        '172.32.0.0',
        '198.20.0.0',
        '223.255.255.255',
        '::2',
        '64:ff9b::808:808',
        '64:ff9b:2::1',
        '2001:200::1',
        '2003::1',
        '3fff:1000::1',
        '5f01::1',
        '::ffff:8.8.8.8'
    ])('allows %s next to a special range', ip => {
        expect(isSpecialPurposeAddress(ip)).toBe(false);
    });

    it.each(['example.com', '', '256.0.0.1', '01.2.3.4', '1.2.3', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::', '::1.2.3.4.5'])(
        'counts %j, which is not an IP address, as special',
        text => {
            expect(isSpecialPurposeAddress(text)).toBe(true);
        }
    );
});
