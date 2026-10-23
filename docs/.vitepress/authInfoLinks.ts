/** Stable anchor for the public AuthInfo interface, distinct from authInfo members. */
export const AUTH_INFO_INTERFACE_ANCHOR = 'authinfo-interface';

const typePage = /^api\/index\/@modelcontextprotocol\/(?:client|server)\/index\.md$/;
const typeTarget = /(?:^|\/)index\/@modelcontextprotocol\/(?:client|server)\/index\.md$/;

export function isAuthInfoInterfacePage(page: string): boolean {
    return typePage.test(page);
}

/** Rewrite only links whose *text* names the AuthInfo type, never member links. */
export function correctAuthInfoTypeHref(href: string, label: string | undefined, page: string): string {
    if (label !== 'AuthInfo' || !href.endsWith('#authinfo')) return href;
    const path = href.slice(0, -'#authinfo'.length);
    if (path ? !typeTarget.test(path) : !isAuthInfoInterfacePage(page)) return href;
    return `${path}#${AUTH_INFO_INTERFACE_ANCHOR}`;
}
