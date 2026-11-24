const test = require('node:test');
const assert = require('node:assert/strict');
const {
    createNativeLocator,
    runBoundedScrollSearch,
    deriveHistoryControlView
} = require('./chatgpt-conversation-navigator.user.js');

function makePage({chatId = 'chat-1', components = []} = {}) {
    const root = {return: null, child: null, stateNode: {}};
    root.stateNode.current = root;
    const fibers = [];
    let previous = null;
    for (const component of components) {
        const fiber = {
            return: root,
            sibling: null,
            memoizedProps: {
                conversationId: component.chatId || chatId,
                entries: component.entries || [{
                    turn: {messageIds: ['message-1']}
                }],
                turnListApi: component.turnListApi
            },
            ref: component.scrollToMessage
                ? {current: {scrollToMessage: component.scrollToMessage}}
                : {current: null}
        };
        fibers.push(fiber);
        if (previous) previous.sibling = fiber;
        else root.child = fiber;
        previous = fiber;
    }

    const element = {};
    if (root.child) {
        Object.defineProperty(element, '__reactFiber$test', {
            configurable: true,
            value: root.child
        });
    }
    const document = {
        documentElement: element,
        querySelectorAll: () => [element]
    };
    const window = {location: {pathname: `/c/${chatId}`}};
    return {document, window, fibers};
}

function makeTurnListApi(scrollToKey = async () => {}) {
    return {
        getEntriesInViewport() {},
        getRowElement() {},
        getEntryGeometry() {},
        measureTurnBeforePaint() {},
        scrollToKey
    };
}

test('native locator works without importing history modules and selects the unique scroll ref', async () => {
    const calls = [];
    const page = makePage({
        components: [
            {},
            {},
            {scrollToMessage: async id => calls.push(id)},
            {}
        ]
    });

    const locator = createNativeLocator({...page, chatId: 'chat-1'});
    assert.equal(await locator.locateMessage('message-1'), true);
    assert.deepEqual(calls, ['message-1']);
    locator.dispose();
});

test('native locator deduplicates turn-list consumers and scrolls to the verified message within its turn', async () => {
    const calls = [];
    const turnListApi = makeTurnListApi(async function (...args) {
        assert.equal(this, turnListApi);
        calls.push(args);
        const messageElement = {};
        assert.equal(args[1]({
            querySelector(selector) {
                assert.equal(selector, '[data-chatgpt-search-message-ids~="escaped-message-2"]');
                return messageElement;
            }
        }), messageElement);
    });
    const entries = [{turnKey: 'turn-1', turn: {messageIds: ['message-1', 'message-2']}}];
    const page = makePage({
        components: [
            {},
            {turnListApi: {scrollToKey() { throw new Error('Incomplete API'); }}},
            {turnListApi, entries},
            {turnListApi, entries},
            {turnListApi: makeTurnListApi(), entries, chatId: 'another-chat'}
        ]
    });
    const escapedIds = [];
    page.window.CSS = {escape(id) { escapedIds.push(id); return `escaped-${id}`; }};
    const locator = createNativeLocator({...page, chatId: 'chat-1'});

    assert.equal(await locator.locateMessage('message-2'), true);
    assert.equal(calls.length, 1);
    const [turnKey, selectTarget, options] = calls[0];
    assert.equal(turnKey, 'turn-1');
    assert.equal(typeof selectTarget, 'function');
    assert.equal(options.align, 'top');
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    assert.deepEqual(escapedIds, ['message-2']);
    locator.dispose();
});

test('turn-list selector returns the matching message element or its row', async () => {
    let selectTarget;
    const messageId = 'message-"1\\id';
    const page = makePage({components: [{
        entries: [{turnKey: 'turn-1', turn: {messageIds: [messageId]}}],
        turnListApi: makeTurnListApi(async (_key, select) => {
            selectTarget = select;
            const messageElement = {};
            const row = {
                querySelector(selector) {
                    assert.equal(selector, '[data-chatgpt-search-message-ids~="message-\\22 1\\5c id"]');
                    return messageElement;
                }
            };
            assert.equal(select(row), messageElement);
            const emptyRow = {querySelector: () => null};
            assert.equal(select(emptyRow), emptyRow);
        })
    }]});
    const locator = createNativeLocator({...page, chatId: 'chat-1'});

    assert.equal(await locator.locateMessage(messageId), true);
    assert.equal(typeof selectTarget, 'function');
    locator.dispose();
});

test('turn-list navigation uses stable geometry when the requested rendered row is recycled', async () => {
    const scrollContainer = {
        clientHeight: 500,
        parentElement: null,
        scrollHeight: 1000,
        scrollTop: 0
    };
    const sourceRow = {
        isConnected: true,
        parentElement: scrollContainer,
        querySelector: () => null
    };
    const entries = [
        {turnKey: 'turn-source', turn: {messageIds: ['message-source']}},
        {turnKey: 'turn-target', turn: {messageIds: ['message-target']}}
    ];
    const turnListApi = {
        ...makeTurnListApi(async () => {}),
        getEntryGeometry: key => key === 'turn-target'
            ? {startPx: 220, endPx: 360}
            : {startPx: 40, endPx: 200},
        getRowElement: key => key === 'turn-source' ? sourceRow : null
    };
    const page = makePage({components: [{turnListApi, entries}]});
    page.window.getComputedStyle = element =>
        element === scrollContainer
            ? {overflowY: 'auto'}
            : {overflowY: 'visible'};
    page.window.setTimeout = callback => {
        callback();
        return 1;
    };
    const locator = createNativeLocator({...page, chatId: 'chat-1'});

    assert.equal(await locator.locateMessage('message-target'), true);
    assert.equal(scrollContainer.scrollTop, 220);
    locator.dispose();
});

test('native locator rejects distinct turn-list APIs and conflicting entries for a shared API', () => {
    const turnListApi = makeTurnListApi();
    const entries = [{turnKey: 'turn-1', turn: {messageIds: ['message-1']}}];
    for (const second of [
        {turnListApi: makeTurnListApi(), entries},
        {turnListApi, entries: entries.slice()}
    ]) {
        const page = makePage({components: [{turnListApi, entries}, second]});
        assert.throws(
            () => createNativeLocator({...page, chatId: 'chat-1'}),
            error => error.code === 'AMBIGUOUS_ACTIVE_CONVERSATION'
        );
    }
});

test('turn-list navigation requires exact unambiguous membership and a nonempty turn key', async () => {
    let calls = 0;
    const page = makePage({components: [{
        entries: [{
            turnKey: 'turn-1',
            turn: {messageIds: ['message-10'], items: [{messageId: 'message-1'}]}
        }],
        turnListApi: makeTurnListApi(async () => { calls += 1; })
    }]});
    const locator = createNativeLocator({...page, chatId: 'chat-1'});

    assert.equal(await locator.locateMessage('message-1'), false);
    assert.equal(await locator.locateMessage('message-10', () => false), false);
    page.fibers[0].memoizedProps.entries = [{turn: {messageIds: ['message-1']}}];
    assert.equal(await locator.locateMessage('message-1'), false);
    page.fibers[0].memoizedProps.entries = [
        {turnKey: 'turn-1', turn: {messageIds: ['message-1']}},
        {turnKey: 'turn-2', turn: {messageIds: ['message-1']}}
    ];
    assert.equal(await locator.locateMessage('message-1'), false);
    assert.equal(calls, 0);
    locator.dispose();
});

test('turn-list navigation rejects a message removed or moved to a different turn during scrolling', async () => {
    for (const replacement of [
        {turnKey: 'turn-1', turn: {messageIds: ['message-2']}},
        {turnKey: 'turn-2', turn: {messageIds: ['message-1']}}
    ]) {
        let finishScroll;
        const page = makePage({components: [{
            entries: [{turnKey: 'turn-1', turn: {messageIds: ['message-1']}}],
            turnListApi: makeTurnListApi(() => new Promise(resolve => { finishScroll = resolve; }))
        }]});
        const locator = createNativeLocator({...page, chatId: 'chat-1'});
        const pending = locator.locateMessage('message-1');
        page.fibers[0].memoizedProps.entries = [replacement];
        finishScroll();
        assert.equal(await pending, false);
        locator.dispose();
    }
});

test('turn-list navigation aborts superseded scrolls and returns false for their completion', async () => {
    const calls = [];
    const page = makePage({components: [{
        entries: [{turnKey: 'turn-1', turn: {messageIds: ['message-1', 'message-2']}}],
        turnListApi: makeTurnListApi((_key, _select, options) => new Promise((resolve, reject) => {
            calls.push({options, resolve});
            options.signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true});
        }))
    }]});
    const locator = createNativeLocator({...page, chatId: 'chat-1'});
    const first = locator.locateMessage('message-1');
    const second = locator.locateMessage('message-2');

    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[1].options.signal.aborted, false);
    calls[1].resolve();
    assert.equal(await first, false);
    assert.equal(await second, true);
    locator.dispose();
});

test('turn-list selector aborts scrolling when request cancellation is observed', async () => {
    let current = true;
    let invokeSelector;
    let signal;
    const page = makePage({components: [{
        entries: [{turnKey: 'turn-1', turn: {messageIds: ['message-1']}}],
        turnListApi: makeTurnListApi((_key, select, options) => new Promise((resolve, reject) => {
            signal = options.signal;
            invokeSelector = () => select({querySelector() { throw new Error('Stale selector'); }});
            signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true});
        }))
    }]});
    const locator = createNativeLocator({...page, chatId: 'chat-1'});
    const pending = locator.locateMessage('message-1', () => current);
    current = false;
    invokeSelector();

    assert.equal(signal.aborted, true);
    assert.equal(await pending, false);
    locator.dispose();
});

test('turn-list navigation aborts and rejects when disposed during scrolling', async () => {
    let signal;
    const page = makePage({components: [{
        entries: [{turnKey: 'turn-1', turn: {messageIds: ['message-1']}}],
        turnListApi: makeTurnListApi((_key, _select, options) => new Promise((resolve, reject) => {
            signal = options.signal;
            signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true});
        }))
    }]});
    const locator = createNativeLocator({...page, chatId: 'chat-1'});
    const pending = locator.locateMessage('message-1');
    locator.dispose();

    assert.equal(signal.aborted, true);
    await assert.rejects(pending, error => error.code === 'LOCATOR_DISPOSED');
});

test('turn-list selector aborts and rejects when the conversation route changes', async () => {
    let invokeSelector;
    let signal;
    const page = makePage({components: [{
        entries: [{turnKey: 'turn-1', turn: {messageIds: ['message-1']}}],
        turnListApi: makeTurnListApi((_key, select, options) => new Promise((resolve, reject) => {
            signal = options.signal;
            invokeSelector = () => {
                try { select({querySelector: () => null}); }
                catch (error) { reject(error); }
            };
        }))
    }]});
    const locator = createNativeLocator({...page, chatId: 'chat-1'});
    const pending = locator.locateMessage('message-1');
    page.window.location.pathname = '/c/chat-2';
    invokeSelector();

    assert.equal(signal.aborted, true);
    await assert.rejects(pending, error => error.code === 'STALE_NATIVE_LOCATOR');
    locator.dispose();
});

test('native locator rejects ambiguous refs for the active conversation', () => {
    const page = makePage({
        components: [
            {scrollToMessage() {}},
            {scrollToMessage() {}}
        ]
    });

    assert.throws(
        () => createNativeLocator({...page, chatId: 'chat-1'}),
        error => error.code === 'AMBIGUOUS_ACTIVE_CONVERSATION'
    );
});

test('native locator verifies membership, current route, and request cancellation before scrolling', async () => {
    let calls = 0;
    const page = makePage({
        components: [{scrollToMessage() { calls += 1; }}]
    });
    const locator = createNativeLocator({...page, chatId: 'chat-1'});

    assert.equal(await locator.locateMessage('missing-message'), false);
    assert.equal(await locator.locateMessage('message-1', () => false), false);
    assert.equal(calls, 0);

    page.window.location.pathname = '/c/chat-2';
    await assert.rejects(
        locator.locateMessage('message-1'),
        error => error.code === 'STALE_NATIVE_LOCATOR'
    );
    assert.equal(calls, 0);
});

test('native locator rejects a message removed from the active branch during native scrolling', async () => {
    let finishScroll;
    const page = makePage({
        components: [{
            entries: [{turn: {messageIds: ['message-1']}}],
            scrollToMessage: () => new Promise(resolve => { finishScroll = resolve; })
        }]
    });
    const locator = createNativeLocator({...page, chatId: 'chat-1'});

    const pending = locator.locateMessage('message-1');
    assert.equal(typeof finishScroll, 'function');
    page.fibers[0].memoizedProps.entries = [
        {turn: {messageIds: ['message-2']}}
    ];
    finishScroll();

    assert.equal(await pending, false);
});

test('bounded scroll search stops at its step limit and honors no-progress limits', async () => {
    let top = 0;
    let probes = 0;
    const result = await runBoundedScrollSearch({
        estimateTop: 10,
        stepSize: 10,
        maxSteps: 7,
        maxNoProgress: 1,
        getTop: () => top,
        setTop: () => {},
        findTarget: () => {
            probes += 1;
            return null;
        },
        waitForStep: async () => {}
    });

    assert.equal(result.reason, 'NOT_FOUND');
    assert.equal(result.steps, 3);
    assert.equal(probes, 3);
});

test('bounded scroll search never exceeds its configured step limit', async () => {
    let top = 0;
    const result = await runBoundedScrollSearch({
        estimateTop: 5,
        stepSize: 10,
        maxSteps: 7,
        getTop: () => top,
        setTop: value => { top = value; },
        findTarget: () => null,
        waitForStep: async () => {}
    });

    assert.equal(result.reason, 'NOT_FOUND');
    assert.equal(result.steps, 7);
});

test('bounded scroll search cancels when a newer request takes ownership', async () => {
    let current = true;
    let top = 0;
    const result = await runBoundedScrollSearch({
        estimateTop: 20,
        stepSize: 10,
        maxSteps: 24,
        getTop: () => top,
        setTop: value => { top = value; },
        findTarget: () => null,
        isCurrent: () => current,
        waitForStep: async () => { current = false; }
    });

    assert.equal(result.reason, 'CANCELLED');
    assert.equal(result.steps, 1);
});

test('history control diagnostics distinguish unknown, unavailable, complete, and no conversation', () => {
    const base = {
        chatOpen: true,
        turnCount: 3,
        adapterConnecting: false,
        loaderState: null,
        pagination: null
    };

    const unknown = deriveHistoryControlView(base);
    assert.equal(unknown.hidden, true);
    assert.equal(unknown.reason, 'unknown');

    const unavailable = deriveHistoryControlView({
        ...base,
        adapterError: {code: 'SUPPORTED_MODULES_UNAVAILABLE'}
    });
    assert.equal(unavailable.hidden, true);
    assert.equal(unavailable.reason, 'unavailable');
    assert.equal(unavailable.reasonCode, 'SUPPORTED_MODULES_UNAVAILABLE');

    const complete = deriveHistoryControlView({
        ...base,
        pagination: {complete: true}
    });
    assert.equal(complete.hidden, true);
    assert.equal(complete.reason, 'complete');

    const noConversation = deriveHistoryControlView({
        ...base,
        chatOpen: false
    });
    assert.equal(noConversation.hidden, true);
    assert.equal(noConversation.reason, 'no-conversation');
});
