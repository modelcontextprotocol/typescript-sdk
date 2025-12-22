import Bowser from 'bowser';

import packageJson from '../../package.json' with { type: 'json' };

export type UserAgentProvider = () => Promise<string>;

const UA_LANG = 'lang/js';

// Declare window for browser environment detection
declare const window: { navigator?: { userAgent?: string } } | undefined;

function isBrowser(): boolean {
    return typeof window !== 'undefined';
}

function uaProduct(): string {
    return `mcp-sdk-ts/${packageJson.version}`;
}

function uaOS(os: string | undefined, version: string | undefined) {
    const osSegment = `os/${os ?? 'unknown'}`;
    if (version) {
        return `${osSegment}#${version}`;
    } else {
        return osSegment;
    }
}

function uaNode(version: string | undefined) {
    const nodeSegment = 'md/nodejs';
    if (version) {
        return `${nodeSegment}#${version}`;
    } else {
        return nodeSegment;
    }
}

function browserUserAgent(): string {
    // window is guaranteed to exist when this function is called (checked by isBrowser())
    const userAgent = window?.navigator?.userAgent;
    const ua = userAgent ? Bowser.parse(userAgent) : undefined;
    return `${uaProduct()} ${uaOS(ua?.os.name, ua?.os.version)} ${UA_LANG}`;
}

async function nodeUserAgent() {
    const { platform, release } = await import('node:os');
    const { versions } = await import('node:process');
    return `${uaProduct()} ${uaOS(platform(), release())} ${UA_LANG} ${uaNode(versions.node)}`;
}

export function createUserAgentProvider(): UserAgentProvider {
    if (isBrowser()) {
        const browserUA = browserUserAgent();
        return () => Promise.resolve(browserUA);
    }

    const nodeUA = nodeUserAgent();
    return () => nodeUA;
}
