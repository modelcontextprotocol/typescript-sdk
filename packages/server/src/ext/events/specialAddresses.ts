const OCTET = String.raw`(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const IPV4 = new RegExp(String.raw`^${OCTET}\.${OCTET}\.${OCTET}\.${OCTET}$`);
const HEX_GROUP = /^[\da-f]{1,4}$/i;

interface Block {
    readonly prefix: bigint;
    readonly shift: bigint;
}

function blockOf(cidr: string, bits: bigint, parse: (text: string) => bigint | undefined): Block {
    const [address = '', length = ''] = cidr.split('/');
    const shift = bits - BigInt(length);
    return { prefix: parse(address)! >> shift, shift };
}

function within(address: bigint, blocks: readonly Block[]): boolean {
    return blocks.some(({ prefix, shift }) => address >> shift === prefix);
}

function parseIpv4(text: string): bigint | undefined {
    const octets = IPV4.exec(text)?.slice(1);
    if (octets === undefined) return undefined;
    let value = 0n;
    for (const octet of octets) value = (value << 8n) | BigInt(octet);
    return value;
}

// The 16-bit groups of one side of `::`; a dotted IPv4 tail is allowed only at the very end of the address.
function groupsOf(part: string, last: boolean): number[] | undefined {
    if (part === '') return [];
    const pieces = part.split(':');
    const groups: number[] = [];
    for (const [index, piece] of pieces.entries()) {
        if (HEX_GROUP.test(piece)) {
            groups.push(Number.parseInt(piece, 16));
            continue;
        }
        const ipv4 = last && index === pieces.length - 1 ? parseIpv4(piece) : undefined;
        if (ipv4 === undefined) return undefined;
        groups.push(Number(ipv4 >> 16n), Number(ipv4 & 0xff_ffn));
    }
    return groups;
}

function parseIpv6(text: string): bigint | undefined {
    // A zone id (`fe80::1%en0`) does not change which range the address is in.
    const halves = text.split('%', 1)[0]!.split('::');
    if (halves.length > 2) return undefined;
    const head = groupsOf(halves[0]!, halves.length === 1);
    const tail = halves.length === 2 ? groupsOf(halves[1]!, true) : [];
    if (head === undefined || tail === undefined) return undefined;
    const zeros = 8 - head.length - tail.length;
    if (halves.length === 1 ? zeros !== 0 : zeros < 1) return undefined;
    let value = 0n;
    for (const group of [...head, ...Array.from({ length: halves.length === 2 ? zeros : 0 }, () => 0), ...tail]) {
        value = (value << 16n) | BigInt(group);
    }
    return value;
}

// Where webhooks are not delivered: ranges from the IANA IPv4 and IPv6 Special-Purpose Address Registries, and multicast.
const IPV4_SPECIAL = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.88.99.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4'
].map(cidr => blockOf(cidr, 32n, parseIpv4));
const IPV6_SPECIAL = [
    '::/128',
    '::1/128',
    '64:ff9b:1::/48',
    '100::/64',
    '2001::/23',
    '2001:db8::/32',
    '2002::/16',
    '3fff::/20',
    '5f00::/16',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8'
].map(cidr => blockOf(cidr, 128n, parseIpv6));
// IPv4-mapped (`::ffff:0:0/96`) and well-known-prefix NAT64 (`64:ff9b::/96`) addresses carry an IPv4 address in their low 32 bits.
const EMBEDS_IPV4 = ['::ffff:0:0/96', '64:ff9b::/96'].map(cidr => blockOf(cidr, 128n, parseIpv6));

// Whether `ip` is in a special-purpose range, an address that embeds an IPv4 address by that IPv4 part; anything that is not an IP address counts as special.
export function isSpecialPurposeAddress(ip: string): boolean {
    const ipv4 = parseIpv4(ip);
    if (ipv4 !== undefined) return within(ipv4, IPV4_SPECIAL);
    const ipv6 = parseIpv6(ip);
    if (ipv6 === undefined) return true;
    if (within(ipv6, EMBEDS_IPV4)) return within(ipv6 & 0xff_ff_ff_ffn, IPV4_SPECIAL);
    return within(ipv6, IPV6_SPECIAL);
}
