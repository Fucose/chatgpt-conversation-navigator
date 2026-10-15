const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, 'chatgpt-conversation-navigator.user.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

function loadCore() {
    const sandbox = {module: {exports: {}}, document: undefined, URL};
    vm.runInNewContext(scriptSource, sandbox, {filename: scriptPath});
    return sandbox.module.exports;
}

function makeFixture({
    pagination = {
        complete: false,
        cursor: 'cursor-1',
        hasLoadedOlderPages: false,
        hasError: false,
        isLoading: false,
        oldestMessageId: 'message-1'
    },
    mr = 'valid',
    includeLegacyMrG = false
} = {}) {
    const chatId = 'chat-1';
    const stateKey = 'state-chat-1';
    const conversationStateSelector = function j() {};
    const paginationSelector = function c() {};
    const scopeToken = {__scopeBrand: 'AppScope', id: Symbol('AppScope')};
    const historyComponent = function HistoryComponent() {};
    const historyExports = {
        OW: {a: scopeToken},
        FG: {c: paginationSelector},
        jfi: {b: async () => {}},
        v7: {flushSync() {}},
        M3K: {a: historyComponent}
    };
    if (mr === 'valid') historyExports.Mr = {j: conversationStateSelector};
    else if (mr !== 'missing') historyExports.Mr = mr;
    if (includeLegacyMrG) historyExports.MrG = {j: conversationStateSelector};

    const webpackRequire = id => {
        if (!Object.prototype.hasOwnProperty.call(historyExports, id)) {
            throw new Error(`Unknown module ${id}`);
        }
        return historyExports[id];
    };
    webpackRequire.m = Object.fromEntries(
        Object.keys(historyExports).map(id => [id, {}])
    );

    const scopeReads = [];
    const scopeNode = {token: scopeToken};
    const scope = {
        scope: scopeToken,
        node: scopeNode,
        chain: {get: id => id === scopeToken.id ? scopeNode : null},
        get(selector, key) {
            scopeReads.push({selector, key});
            if (selector === conversationStateSelector && key === chatId) return stateKey;
            if (selector === paginationSelector && key === stateKey) return pagination;
            return undefined;
        },
        set() {},
        watch() {},
        when() {}
    };

    const entries = [{
        id: 'entry-1',
        turnKey: 'turn-1',
        turn: {
            messageIds: ['message-1', 'message-2'],
            items: [
                {type: 'user-message', messageId: 'message-1', message: 'hello'},
                {type: 'assistant-message', messageId: 'message-2', content: 'hi'}
            ]
        }
    }];
    const fiber = {
        return: null,
        sibling: null,
        child: null,
        type: historyComponent,
        elementType: historyComponent,
        memoizedProps: {
            conversationId: chatId,
            entries,
            ref: {current: {scrollToMessage() {}}}
        },
        memoizedState: {memoizedState: {current: scope}, next: null}
    };
    const root = {return: null, child: fiber, sibling: null, stateNode: null};
    root.stateNode = {current: root};
    fiber.return = root;

    const pageElement = {};
    Object.defineProperty(pageElement, '__reactFiber$test', {value: fiber});
    const document = {
        documentElement: pageElement,
        querySelectorAll(selector) {
            if (selector === 'link[rel="modulepreload"][href]') return [];
            if (selector === '*') return [pageElement];
            return [];
        }
    };
    const assetUrl = 'https://chatgpt.com/cdn/assets/conversation.js';
    const importUrls = [];
    const window = {
        location: {
            href: 'https://chatgpt.com/c/chat-1',
            origin: 'https://chatgpt.com',
            pathname: '/c/chat-1'
        },
        __reactRouterManifest: {
            routes: {
                conversation: {
                    id: 'conversation',
                    path: '/c/:id',
                    imports: ['/cdn/assets/conversation.js']
                }
            }
        },
        performance: {getEntriesByType: () => []}
    };

    return {
        document,
        window,
        importModule: async url => {
            importUrls.push(url);
            return {__webpack_require__: webpackRequire};
        },
        importUrls,
        scopeReads,
        conversationStateSelector,
        paginationSelector,
        historyExports,
        assetUrl,
        chatId
    };
}

test('native adapter rejects a missing Mr module even when legacy MrG.j exists', async () => {
    const fixture = makeFixture({mr: 'missing', includeLegacyMrG: true});
    const {createNativeAdapter} = loadCore();

    await assert.rejects(
        createNativeAdapter({...fixture, chatId: fixture.chatId}),
        error => error.code === 'SUPPORTED_MODULES_UNAVAILABLE'
    );
    assert.deepEqual(fixture.importUrls, [fixture.assetUrl]);
});

test('native adapter rejects an invalid Mr.j selector export', async () => {
    const fixture = makeFixture({mr: {j: null}});
    const {createNativeAdapter} = loadCore();

    await assert.rejects(
        createNativeAdapter({...fixture, chatId: fixture.chatId}),
        error => error.code === 'SUPPORTED_MODULE_SHAPE_UNKNOWN'
    );
});

test('native adapter discovers current Mr.j without MrG and reads the conversation scope', async () => {
    const fixture = makeFixture();
    const {createNativeAdapter} = loadCore();
    const adapter = await createNativeAdapter({...fixture, chatId: fixture.chatId});

    const snapshot = adapter.readSnapshot();
    assert.equal(snapshot.chatId, fixture.chatId);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].userText, 'hello');
    assert.equal(snapshot.entries[0].assistantText, 'hi');
    assert.equal(snapshot.pagination.available, true);
    assert.equal(snapshot.pagination.canLoadPrevious, true);
    assert.equal(Object.hasOwn(fixture.historyExports, 'Mr'), true);
    assert.equal(Object.hasOwn(fixture.historyExports, 'MrG'), false);
    assert.deepEqual(fixture.importUrls, [fixture.assetUrl]);
    assert.equal(fixture.scopeReads[0].selector, fixture.conversationStateSelector);
    assert.equal(fixture.scopeReads[0].key, fixture.chatId);
    assert.equal(fixture.scopeReads[1].selector, fixture.paginationSelector);
    assert.equal(fixture.scopeReads[1].key, 'state-chat-1');
    adapter.dispose();
});

test('native adapter treats a null cursor with older pages loaded as pagination exhaustion', async () => {
    const fixture = makeFixture({
        pagination: {
            complete: false,
            cursor: null,
            hasLoadedOlderPages: true,
            hasError: false,
            isLoading: false
        }
    });
    const {createNativeAdapter} = loadCore();
    const adapter = await createNativeAdapter({...fixture, chatId: fixture.chatId});

    const {pagination} = adapter.readSnapshot();
    assert.equal(pagination.complete, true);
    assert.equal(pagination.cursor, null);
    assert.equal(pagination.canLoadPrevious, false);
    adapter.dispose();
});
