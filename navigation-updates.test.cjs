const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, 'chatgpt-conversation-navigator.user.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

function createFakeTimers() {
    let now = 0;
    let nextId = 1;
    const tasks = new Map();

    function schedule(callback, delay, interval = 0) {
        const id = nextId++;
        const normalizedDelay = Math.max(0, Number(delay) || 0);
        tasks.set(id, {
            id,
            callback,
            due: now + normalizedDelay,
            interval
        });
        return id;
    }

    function advance(milliseconds) {
        const target = now + milliseconds;
        let executions = 0;
        while (true) {
            const task = Array.from(tasks.values())
                .filter(candidate => candidate.due <= target)
                .sort((left, right) => left.due - right.due || left.id - right.id)[0];
            if (!task) break;
            if (++executions > 10000) {
                throw new Error('Fake timer execution limit exceeded.');
            }
            now = task.due;
            if (task.interval) task.due += task.interval;
            else tasks.delete(task.id);
            task.callback();
        }
        now = target;
    }

    return {
        now: () => now,
        setTimeout: (callback, delay) => schedule(callback, delay),
        clearTimeout: id => tasks.delete(id),
        setInterval: (callback, delay) => schedule(callback, delay, Number(delay)),
        clearInterval: id => tasks.delete(id),
        advance
    };
}

function loadPipelineRuntime() {
    const timers = createFakeTimers();
    const eventListeners = new Map();
    const document = {
        readyState: 'loading',
        body: {},
        addEventListener(type, callback) {
            const listeners = eventListeners.get(type) || [];
            listeners.push(callback);
            eventListeners.set(type, listeners);
        },
        getElementById() { return null; }
    };
    let observerCallback = null;
    class FakeMutationObserver {
        constructor(callback) {
            observerCallback = callback;
        }
        observe() {}
        disconnect() {}
    }
    class FakeElement {}
    class FakeDate extends Date {
        static now() { return timers.now(); }
    }
    const window = {
        location: {pathname: '/c/chat'},
        addEventListener() {},
        removeEventListener() {}
    };
    const sandbox = {
        document,
        window,
        history: {},
        Element: FakeElement,
        MutationObserver: FakeMutationObserver,
        Date: FakeDate,
        URL,
        module: {exports: {}},
        console: {info() {}, warn() {}, error() {}},
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        setInterval: timers.setInterval,
        clearInterval: timers.clearInterval,
        requestAnimationFrame: callback => timers.setTimeout(callback, 16),
        cancelAnimationFrame: timers.clearTimeout
    };
    const hooks = `
    globalThis.__pipeline = (() => {
        const setters = {
            getChatIdentity: value => { getChatIdentity = value; },
            ensureUI: value => { ensureUI = value; },
            collectTurns: value => { collectTurns = value; },
            trackCurrentRouteTurn: value => { trackCurrentRouteTurn = value; },
            mergeObservedTurnRecords: value => { mergeObservedTurnRecords = value; },
            syncThreadResizeTargets: value => { syncThreadResizeTargets = value; },
            buildRenderedTurns: value => { buildRenderedTurns = value; },
            updateHistoryControl: value => { updateHistoryControl = value; },
            updateReplyTopButton: value => { updateReplyTopButton = value; },
            updateRailDensity: value => { updateRailDensity = value; },
            scheduleActiveUpdate: value => { scheduleActiveUpdate = value; },
            resetNativeAdapterRetryBackoff: value => { resetNativeAdapterRetryBackoff = value; },
            reportRouteCapability: value => { reportRouteCapability = value; },
            cancelJumpSearch: value => { cancelJumpSearch = value; },
            clearExtendedScrollRange: value => { clearExtendedScrollRange = value; },
            clearNavigation: value => { clearNavigation = value; },
            transferChatTurnIdentities: value => { transferChatTurnIdentities = value; },
            resetReplyNavigationForConversationChange: value => { resetReplyNavigationForConversationChange = value; },
            startNativeLocator: value => { startNativeLocator = value; },
            startNativeAdapter: value => { startNativeAdapter = value; },
            isOwnNavigationMutation: value => { isOwnNavigationMutation = value; },
            replyOutlineHeaderMayHaveChanged: value => { replyOutlineHeaderMayHaveChanged = value; },
            isReplySidebarMutation: value => { isReplySidebarMutation = value; },
            captureUserEditCandidatesFromMutation: value => { captureUserEditCandidatesFromMutation = value; },
            findKnownUserContentTurn: value => { findKnownUserContentTurn = value; },
            nodeIsWithinMountedThread: value => { nodeIsWithinMountedThread = value; },
            nodeContainsTurn: value => { nodeContainsTurn = value; },
            queueAssistantBarRefresh: value => { queueAssistantBarRefresh = value; },
            invalidateThreadLayout: value => { invalidateThreadLayout = value; },
            scheduleNativeSnapshotRefresh: value => { scheduleNativeSnapshotRefresh = value; },
            retryNativeLocatorBinding: value => { retryNativeLocatorBinding = value; },
            retryNativeAdapterBinding: value => { retryNativeAdapterBinding = value; },
            toIndexRecord: value => { toIndexRecord = value; }
        };
        const renderCalls = [];
        return {
            scheduleRebuild,
            pollForUnobservedChanges,
            startFallbackPolling,
            observeChatChanges,
            acceptNativeSnapshot,
            get renderTurns() { return renderTurns; },
            handleRouteChange,
            buildFirstRecordByEntry,
            getTurnRecordStore,
            getConversationIndex,
            setCurrentChatIdentity(value) { currentChatIdentity = value; },
            setSubmissionPending(value) { newConversationSubmissionPending = value; },
            setRenderElements(elements) {
                barList = elements.barList;
                rail = elements.rail;
                preview = elements.preview;
            },
            setStub(name, value) {
                if (!setters[name]) throw new Error('Unknown pipeline stub: ' + name);
                setters[name](value);
            },
            wrapRender() {
                const original = renderTurns;
                renderTurns = function (...args) {
                    renderCalls.push(currentChatIdentity);
                    return original.apply(this, args);
                };
                return renderCalls;
            },
            get renderCalls() { return renderCalls; },
            get observerCallback() { return globalThis.__observerState.callback; },
            get state() {
                return {
                    currentChatIdentity,
                    rebuildDirty,
                    rebuildTimer,
                    rebuildMaxWaitTimer,
                    rebuildImmediatePending,
                    latestNativePagination
                };
            }
        };
    })();
    `;
    const instrumentedSource = scriptSource.replace(/\}\)\(\);\s*$/, `${hooks}\n})();`);
    assert.notEqual(instrumentedSource, scriptSource, 'IIFE test hook was inserted');
    vm.runInNewContext(instrumentedSource, sandbox, {filename: scriptPath});
    sandbox.__observerState = {get callback() { return observerCallback; }};
    const pipeline = sandbox.__pipeline;
    pipeline.setRenderElements({
        barList: {children: [], replaceChildren() { this.children = []; }},
        rail: {style: {}},
        preview: {classList: {remove() {}}}
    });

    return {pipeline, sandbox, timers, eventListeners};
}

function prepareRenderer(runtime) {
    const {pipeline, sandbox} = runtime;
    let collectCount = 0;
    let observedTurns = [];
    pipeline.setCurrentChatIdentity('conversation:chat');
    sandbox.window.location.pathname = '/c/chat';
    pipeline.setStub('ensureUI', () => {});
    pipeline.setStub('collectTurns', () => {
        collectCount += 1;
        return observedTurns;
    });
    pipeline.setStub('trackCurrentRouteTurn', () => true);
    pipeline.setStub('mergeObservedTurnRecords', () => {});
    pipeline.setStub('syncThreadResizeTargets', () => {});
    pipeline.setStub('buildRenderedTurns', () => []);
    pipeline.setStub('updateHistoryControl', () => {});
    pipeline.setStub('updateReplyTopButton', () => {});
    pipeline.setStub('updateRailDensity', () => {});
    pipeline.setStub('scheduleActiveUpdate', () => {});
    pipeline.setStub('resetNativeAdapterRetryBackoff', () => {});
    pipeline.setStub('reportRouteCapability', () => {});
    pipeline.setStub('isOwnNavigationMutation', () => false);
    pipeline.setStub('retryNativeLocatorBinding', () => {});
    pipeline.setStub('retryNativeAdapterBinding', () => {});
    return {
        get collectCount() { return collectCount; },
        setObservedTurns(turns) { observedTurns = turns; }
    };
}

function prepareRouteEffects(pipeline) {
    for (const name of [
        'cancelJumpSearch',
        'clearExtendedScrollRange',
        'clearNavigation',
        'transferChatTurnIdentities',
        'resetReplyNavigationForConversationChange',
        'startNativeLocator',
        'startNativeAdapter'
    ]) {
        pipeline.setStub(name, () => {});
    }
}

function fireUnclassifiedMutation(pipeline) {
    pipeline.observeChatChanges();
    pipeline.observerCallback([{
        type: 'childList',
        target: {},
        addedNodes: [],
        removedNodes: []
    }]);
}

test('snapshot projections are queued immediately and merge with following DOM changes', () => {
    const runtime = loadPipelineRuntime();
    const metrics = prepareRenderer(runtime);
    const {pipeline, sandbox, timers} = runtime;
    let historyUpdates = 0;
    pipeline.setStub('updateHistoryControl', () => { historyUpdates += 1; });
    pipeline.setStub('getChatIdentity', () => 'conversation:chat');
    const renderCalls = pipeline.wrapRender();

    const firstSnapshot = {
        chatId: 'chat',
        branchKey: 'branch',
        entries: [{
            identity: 'native-turn',
            kind: 'user',
            userMessageId: 'native-user',
            userText: 'first snapshot'
        }],
        pagination: {canLoadPrevious: true, cursor: 'older-1'}
    };
    const secondSnapshot = {
        ...firstSnapshot,
        entries: [{...firstSnapshot.entries[0], userText: 'latest snapshot'}],
        pagination: {canLoadPrevious: true, cursor: 'older-2'}
    };

    assert.equal(pipeline.acceptNativeSnapshot(firstSnapshot), true);
    assert.equal(pipeline.acceptNativeSnapshot(secondSnapshot), true);
    fireUnclassifiedMutation(pipeline);

    const store = pipeline.getTurnRecordStore('conversation:chat');
    assert.equal(store.index.getEntries()[0].userText, 'latest snapshot');
    assert.equal(store.turns[0].userText, 'latest snapshot');
    assert.equal(pipeline.state.latestNativePagination.cursor, 'older-2');
    assert.equal(historyUpdates, 2);
    assert.equal(renderCalls.length, 0);
    assert.equal(metrics.collectCount, 0);
    assert.equal(pipeline.state.rebuildImmediatePending, true);

    timers.advance(0);

    assert.equal(renderCalls.length, 1);
    assert.equal(renderCalls[0], 'conversation:chat');
    assert.equal(metrics.collectCount, 1);
});

test('unclassified mutations wait for the periodic dirty poll; idle polls do not scan', () => {
    const runtime = loadPipelineRuntime();
    const metrics = prepareRenderer(runtime);
    const {pipeline, timers} = runtime;
    const renderCalls = pipeline.wrapRender();
    let locatorRetries = 0;
    let adapterRetries = 0;
    pipeline.setStub('retryNativeLocatorBinding', () => { locatorRetries += 1; });
    pipeline.setStub('retryNativeAdapterBinding', () => { adapterRetries += 1; });
    pipeline.startFallbackPolling();

    timers.advance(2500);
    assert.equal(renderCalls.length, 0);
    assert.equal(metrics.collectCount, 0);
    assert.equal(locatorRetries, 1);
    assert.equal(adapterRetries, 1);

    fireUnclassifiedMutation(pipeline);
    assert.equal(pipeline.state.rebuildDirty, true);
    assert.equal(pipeline.state.rebuildTimer, null);
    assert.equal(metrics.collectCount, 0);
    timers.advance(2499);
    assert.equal(renderCalls.length, 0);
    assert.equal(metrics.collectCount, 0);

    timers.advance(1);
    assert.equal(pipeline.state.rebuildTimer !== null, true);
    assert.equal(renderCalls.length, 0);
    timers.advance(180);

    assert.equal(renderCalls.length, 1);
    assert.equal(metrics.collectCount, 1);
});

test('identity attributes and added subtrees are tracked locally', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline} = runtime;
    prepareRenderer(runtime);
    const attributeTarget = {};
    const addedTarget = {};
    const tracked = [];
    const collectedScopes = [];
    pipeline.setStub('collectTurns', scope => {
        collectedScopes.push(scope);
        if (scope === attributeTarget) {
            return [{identity: 'attribute-turn', stableIdentity: true}];
        }
        if (scope === addedTarget) {
            return [{identity: 'added-turn', stableIdentity: true}];
        }
        return [];
    });
    pipeline.setStub('trackCurrentRouteTurn', turn => {
        tracked.push(turn.identity);
        return true;
    });
    pipeline.setStub('nodeContainsTurn', node =>
        node === attributeTarget || node === addedTarget
    );
    pipeline.observeChatChanges();

    pipeline.observerCallback([
        {
            type: 'attributes',
            target: attributeTarget,
            attributeName: 'data-turn-key',
            addedNodes: [],
            removedNodes: []
        },
        {
            type: 'childList',
            target: {},
            attributeName: null,
            addedNodes: [addedTarget],
            removedNodes: []
        }
    ]);

    assert.deepEqual(tracked, ['attribute-turn', 'added-turn']);
    assert.equal(collectedScopes.length, 2);
    assert.equal(collectedScopes[0], attributeTarget);
    assert.equal(collectedScopes[1], addedTarget);
    assert.equal(pipeline.state.rebuildDirty, true);
});

test('relevant mutation bursts use trailing debounce and a fixed maxWait', () => {
    const runtime = loadPipelineRuntime();
    const metrics = prepareRenderer(runtime);
    const {pipeline, timers} = runtime;
    const renderCalls = pipeline.wrapRender();

    fireUnclassifiedMutation(pipeline);
    assert.equal(pipeline.state.rebuildTimer !== null, false);
    pipeline.scheduleRebuild();
    timers.advance(100);
    pipeline.scheduleRebuild();
    timers.advance(179);
    assert.equal(renderCalls.length, 0);
    timers.advance(1);
    assert.equal(renderCalls.length, 1);
    assert.equal(metrics.collectCount, 1);

    for (let elapsed = 0; elapsed < 2500; elapsed += 100) {
        pipeline.scheduleRebuild();
        timers.advance(100);
    }
    assert.equal(renderCalls.length, 2);
    assert.equal(metrics.collectCount, 2);
    timers.advance(1000);
    assert.equal(renderCalls.length, 2);
});

test('renderTurns consumes pending timers and dirty state when called synchronously', () => {
    const runtime = loadPipelineRuntime();
    const metrics = prepareRenderer(runtime);
    const {pipeline, timers} = runtime;
    const renderCalls = pipeline.wrapRender();

    pipeline.scheduleRebuild();
    assert.equal(pipeline.state.rebuildDirty, true);
    assert.notEqual(pipeline.state.rebuildTimer, null);
    pipeline.setStub('getChatIdentity', () => 'conversation:chat');
    pipeline.renderTurns();

    assert.equal(pipeline.state.rebuildDirty, false);
    assert.equal(pipeline.state.rebuildTimer, null);
    assert.equal(pipeline.state.rebuildMaxWaitTimer, null);
    assert.equal(metrics.collectCount, 1);
    timers.advance(2500);
    assert.equal(renderCalls.length, 1);
});

test('route changes cancel old timers and schedule both normal routes and promotion', () => {
    for (const scenario of ['normal', 'promotion']) {
        const runtime = loadPipelineRuntime();
        const {pipeline, sandbox, timers} = runtime;
        const metrics = prepareRenderer(runtime);
        prepareRouteEffects(pipeline);
        const renderCalls = pipeline.wrapRender();

        if (scenario === 'normal') {
            pipeline.setCurrentChatIdentity('conversation:old');
            sandbox.window.location.pathname = '/c/old';
        } else {
            pipeline.setCurrentChatIdentity('route:/');
            sandbox.window.location.pathname = '/';
            pipeline.setSubmissionPending(true);
        }
        pipeline.scheduleRebuild();
        timers.advance(100);
        sandbox.window.location.pathname = '/c/new';
        pipeline.handleRouteChange();

        assert.equal(pipeline.state.currentChatIdentity, 'conversation:new');
        assert.equal(pipeline.state.rebuildDirty, true);
        assert.notEqual(pipeline.state.rebuildTimer, null);
        timers.advance(0);

        assert.equal(renderCalls.length, 1);
        assert.equal(renderCalls[0], 'conversation:new');
        assert.equal(metrics.collectCount, 1);
        timers.advance(2500);
        assert.equal(renderCalls.length, 1);
    }
});

test('renderTurn alias resolution is shared by mounted and label source maps', () => {
    const runtime = loadPipelineRuntime();
    const metrics = prepareRenderer(runtime);
    const {pipeline} = runtime;
    const index = pipeline.getConversationIndex('conversation:chat');
    index.upsertObserved([
        {identity: 'first', kind: 'user', userMessageId: 'user-first'},
        {identity: 'second', kind: 'user', userMessageId: 'user-second'}
    ]);
    const originalResolve = index.resolveEntry;
    let resolveCount = 0;
    index.resolveEntry = function (...args) {
        resolveCount += 1;
        return originalResolve.apply(this, args);
    };
    pipeline.setStub('toIndexRecord', turn => ({
        identity: turn.identity,
        kind: turn.kind
    }));
    metrics.setObservedTurns([
        {identity: 'first', kind: 'user', root: {isConnected: true}},
        {identity: 'second', kind: 'user', root: {isConnected: true}}
    ]);
    pipeline.wrapRender();

    pipeline.renderTurns();

    assert.equal(resolveCount, 2);
    assert.equal(metrics.collectCount, 1);
});

test('entry fallback records are derived once and retain first-match order', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline} = runtime;
    const store = pipeline.getTurnRecordStore('conversation:fallback');
    const entries = store.index.applySnapshot({
        branchKey: 'branch',
        entries: [
            {identity: 'target-0', kind: 'user', messageId: 'shared'},
            {identity: 'target-1', kind: 'user', messageId: 'shared'},
            ...Array.from({length: 38}, (_, i) => ({
                identity: `target-${i + 2}`,
                kind: 'user',
                userMessageId: `user-${i + 2}`
            }))
        ]
    }).entries;
    const candidates = [
        {identity: 'fallback-first', kind: 'user', messageId: 'shared'},
        {identity: 'fallback-second', kind: 'user', messageId: 'shared'},
        {identity: 'target-1', kind: 'user'}
    ];
    for (let i = 2; i < 40; i += 1) {
        candidates.push({identity: `target-${i}`, kind: 'user'});
    }
    let conversionCount = 0;
    pipeline.setStub('toIndexRecord', record => {
        conversionCount += 1;
        return record;
    });

    const recordsByEntry = pipeline.buildFirstRecordByEntry(
        store,
        entries,
        candidates
    );

    assert.equal(conversionCount, candidates.length);
    assert.equal(recordsByEntry.size, entries.length);
    assert.equal(recordsByEntry.get(entries[0]), candidates[0]);
    assert.equal(recordsByEntry.get(entries[1]).identity, 'target-1');
    assert.equal(Object.hasOwn(store, 'nativeBranchKey'), false);
});
