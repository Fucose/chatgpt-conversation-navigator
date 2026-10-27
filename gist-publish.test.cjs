'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {publishGist} = require('./.github/scripts/publish-gist.cjs');

const GIST_ID = 'fc9f1963666d75e7f93a5edceae137c7';
const FILENAME = 'chatgpt-conversation-navigator.user.js';
const API_URL = `https://api.github.com/gists/${GIST_ID}`;
const RAW_PREFIX = `https://gist.githubusercontent.com/Fucose/${GIST_ID}/raw/`;
const RAW_URL = `${RAW_PREFIX}${FILENAME}`;
const OLD_URL = `${RAW_PREFIX}${'a'.repeat(40)}/${FILENAME}`;
const NEW_URL = `${RAW_PREFIX}${'b'.repeat(40)}/${FILENAME}`;

function userscript(version, options = {}) {
    return Buffer.from([
        '// ==UserScript==',
        `// @version      ${version}`,
        `// @updateURL    ${options.updateURL || RAW_URL}`,
        `// @downloadURL  ${options.downloadURL || RAW_URL}`,
        '// ==/UserScript==',
        options.body || 'console.log("示例");',
        ''
    ].join('\n'));
}

function mockGist(oldContent, options = {}) {
    const calls = [];
    let newContent;
    let latestReads = 0;
    const gist = (url) => ({id: GIST_ID, files: {[FILENAME]: {raw_url: url}}});
    const fetchImpl = async (url, request = {}) => {
        calls.push({url, request});
        if (url === API_URL && request.method === 'GET') {
            return Response.json(options.current || gist(OLD_URL));
        }
        if (url === API_URL && request.method === 'PATCH') {
            newContent = Buffer.from(JSON.parse(request.body).files[FILENAME].content);
            return Response.json(gist(NEW_URL));
        }
        if (url === OLD_URL) return new Response(oldContent);
        if (url === NEW_URL) return new Response(options.badRevision ? oldContent : newContent);
        if (url === RAW_URL) {
            latestReads += 1;
            return new Response(latestReads <= (options.staleReads || 0) ? oldContent : (newContent || oldContent));
        }
        throw new Error('Unexpected mocked URL');
    };
    return {calls, fetchImpl};
}

function args(content, mock, overrides = {}) {
    return {
        repository: 'Fucose/chatgpt-conversation-navigator',
        token: 'test-token',
        tag: 'v0.5.2',
        content,
        fetchImpl: mock.fetchImpl,
        delay: async () => {},
        ...overrides
    };
}

test('publishes only the userscript, retries stale raw content, and verifies both URLs', async () => {
    const content = userscript('0.5.2');
    const mock = mockGist(userscript('0.5.1'), {staleReads: 2});
    const waits = [];
    const result = await publishGist(args(content, mock, {delay: async (ms) => waits.push(ms)}));

    assert.equal(result, 'published');
    const apiCalls = mock.calls.filter((call) => call.url === API_URL);
    assert.deepEqual(apiCalls.map((call) => call.request.method), ['GET', 'PATCH']);
    assert.deepEqual(JSON.parse(apiCalls[1].request.body), {files: {[FILENAME]: {content: content.toString('utf8')}}});
    assert.equal(apiCalls[1].request.headers.Authorization, 'Bearer test-token');
    assert.deepEqual(waits, [15000, 15000]);
    assert.equal(mock.calls.filter((call) => call.url === NEW_URL).length, 1);
    assert.equal(mock.calls.filter((call) => call.url === RAW_URL).length, 3);
    for (const call of mock.calls.filter((item) => item.url !== API_URL)) {
        assert.equal(call.request.headers.Authorization, undefined);
    }
});

test('an identical current version is a verified no-op', async () => {
    const content = userscript('0.5.2');
    const mock = mockGist(content);
    assert.equal(await publishGist(args(content, mock)), 'already current');
    assert.equal(mock.calls.some((call) => call.request.method === 'PATCH'), false);
    assert.equal(mock.calls.filter((call) => call.url === OLD_URL).length, 2);
    assert.equal(mock.calls.filter((call) => call.url === RAW_URL).length, 1);
});

test('rejects older releases and changed bytes at the same version', async () => {
    for (const oldContent of [userscript('0.5.3'), userscript('0.5.2', {body: 'different content'})]) {
        const mock = mockGist(oldContent);
        await assert.rejects(publishGist(args(userscript('0.5.2'), mock)), /Refusing to/);
        assert.equal(mock.calls.some((call) => call.request.method === 'PATCH'), false);
    }
});

test('rejects missing credentials, wrong repository, invalid tags, and mismatched metadata before requests', async () => {
    const invalidCases = [
        {token: '', error: /GIST_TOKEN secret is missing/},
        {repository: 'someone/other', error: /allowed only from/},
        {tag: 'v0.05.2', error: /Release tag/},
        {tag: 'v0.5.2-rc1', error: /Release tag/},
        {tag: 'v0.5.3', error: /does not match/},
        {content: userscript('0.5.2', {updateURL: 'https://example.com/other'}), error: /existing Gist URL/},
        {content: userscript('0.5.2', {downloadURL: 'https://example.com/other'}), error: /existing Gist URL/},
        {content: Buffer.from([0xff]), error: /UTF-8/}
    ];
    for (const {error, ...overrides} of invalidCases) {
        const mock = mockGist(userscript('0.5.1'));
        await assert.rejects(publishGist(args(userscript('0.5.2'), mock, overrides)), error);
        assert.equal(mock.calls.length, 0);
    }
});

test('refuses a missing file or unexpected revision URL before publishing', async () => {
    for (const current of [
        {id: GIST_ID, files: {}},
        {id: GIST_ID, files: {[FILENAME]: {raw_url: 'https://example.com/wrong'}}}
    ]) {
        const mock = mockGist(userscript('0.5.1'), {current});
        await assert.rejects(publishGist(args(userscript('0.5.2'), mock)), /expected file or its revision URL/);
        assert.equal(mock.calls.some((call) => call.request.method === 'PATCH'), false);
    }
});

test('fails after bounded retries if the returned revision or stable URL differs', async () => {
    for (const options of [{badRevision: true}, {staleReads: 21}]) {
        const mock = mockGist(userscript('0.5.1'), options);
        await assert.rejects(publishGist(args(userscript('0.5.2'), mock)), /verification failed after 21 attempts/);
        const failedUrl = options.badRevision ? NEW_URL : RAW_URL;
        assert.equal(mock.calls.filter((call) => call.url === failedUrl).length, 21);
    }
});
