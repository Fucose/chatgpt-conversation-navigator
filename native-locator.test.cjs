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
                }]
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
