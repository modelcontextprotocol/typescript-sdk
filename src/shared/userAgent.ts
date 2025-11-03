import * as Bowser from 'bowser';
import packageJson from '../../package.json';

export type UserAgentProvider = () => Promise<string>;

const UA_LANG = 'lang/js';

function isBrowser() {
    return typeof window !== 'undefined';
}

function uaProduct() {
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

function browserUserAgent() {
    const ua = window.navigator?.userAgent ? Bowser.parse(window.navigator.userAgent) : undefined;
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
