import assert from 'node:assert/strict';
import test from 'node:test';
import { AUTH_INFO_INTERFACE_ANCHOR, correctAuthInfoTypeHref, isAuthInfoInterfacePage } from './authInfoLinks.ts';

const server = 'api/index/@modelcontextprotocol/server/index.md';
const client = 'api/index/@modelcontextprotocol/client/index.md';
const middleware = 'api/@modelcontextprotocol/server/server/middleware/bearerAuth.md';

test('public client/server interface pages receive a stable target', () => {
    assert.equal(AUTH_INFO_INTERFACE_ANCHOR, 'authinfo-interface');
    assert.equal(isAuthInfoInterfacePage(server), true);
    assert.equal(isAuthInfoInterfacePage(client), true);
    assert.equal(isAuthInfoInterfacePage(middleware), false);
});

test('correct AuthInfo type links but never member links', () => {
    const href = '../../../../index/@modelcontextprotocol/server/index.md#authinfo';
    assert.equal(correctAuthInfoTypeHref(href, 'AuthInfo', middleware), href.replace('#authinfo', '#authinfo-interface'));
    assert.equal(correctAuthInfoTypeHref(href, 'authInfo', middleware), href);
    const sibling = '../../../../index/@modelcontextprotocol/server/index.md#authinfo-1';
    assert.equal(correctAuthInfoTypeHref(sibling, 'AuthInfo', middleware), sibling);
});

test('preserve unrelated local anchors and targets', () => {
    assert.equal(correctAuthInfoTypeHref('#authinfo', 'AuthInfo', server), '#authinfo-interface');
    assert.equal(correctAuthInfoTypeHref('#authinfo', 'authInfo', server), '#authinfo');
    assert.equal(correctAuthInfoTypeHref('#authinfo', 'AuthInfo', middleware), '#authinfo');
    const unrelated = '../../../../auth/index.md#authinfo';
    assert.equal(correctAuthInfoTypeHref(unrelated, 'AuthInfo', middleware), unrelated);
    const clientHref = '../../../index/@modelcontextprotocol/client/index.md#authinfo';
    assert.equal(correctAuthInfoTypeHref(clientHref, 'AuthInfo', middleware), clientHref.replace('#authinfo', '#authinfo-interface'));
});
