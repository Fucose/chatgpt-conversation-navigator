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
    let structureNodes = [];
    const document = {
        readyState: 'loading',
        body: {},
        addEventListener(type, callback) {
            const listeners = eventListeners.get(type) || [];
            listeners.push(callback);
            eventListeners.set(type, listeners);
        },
        getElementById() { return null; },
        querySelectorAll() { return structureNodes; }
    };
    let observerCallback = null;
    let observerOptions = null;
    class FakeMutationObserver {
        constructor(callback) {
            observerCallback = callback;
        }
        observe(target, options) { observerOptions = options; }
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
            queueTurnContentRefresh: value => { queueTurnContentRefresh = value; },
            invalidateThreadLayout: value => { invalidateThreadLayout = value; },
            scheduleNativeSnapshotRefresh: value => { scheduleNativeSnapshotRefresh = value; },
            retryNativeLocatorBinding: value => { retryNativeLocatorBinding = value; },
            retryNativeAdapterBinding: value => { retryNativeAdapterBinding = value; },
            toIndexRecord: value => { toIndexRecord = value; }
        };
        const renderCalls = [];
        return {
            scheduleRebuild,
            cancelRebuildSchedule,
            pollForUnobservedChanges,
            startFallbackPolling,
            observeChatChanges,
            acceptNativeSnapshot,
            get renderTurns() { return renderTurns; },
            handleRouteChange,
            getTurnRecordStore,
            getConversationIndex,
            setMountedAndRenderedTurns(mounted, rendered) {
                mountedTurnsByIdentity = new Map(mounted);
                turns = rendered;
            },
            unmountTurn(identity) { mountedTurnsByIdentity.delete(identity); },
            setEditCandidate(identity) { userEditCandidates.set(identity, {}); },
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
            get observerOptions() { return globalThis.__observerState.options; },
            get state() {
                return {
                    currentChatIdentity,
                    rebuildDirty,
                    rebuildTimer,
                    rebuildMaxWaitTimer,
                    rebuildImmediatePending,
                    contentRefreshTimer,
                    latestNativePagination
                };
            }
        };
    })();
    `;
    const instrumentedSource = scriptSource.replace(/\}\)\(\);\s*$/, `${hooks}\n})();`);
    assert.notEqual(instrumentedSource, scriptSource, 'IIFE test hook was inserted');
    vm.runInNewContext(instrumentedSource, sandbox, {filename: scriptPath});
    sandbox.__observerState = {
        get callback() { return observerCallback; },
        get options() { return observerOptions; }
    };
    const pipeline = sandbox.__pipeline;
    pipeline.setRenderElements({
        barList: {children: [], replaceChildren() { this.children = []; }},
        rail: {style: {}},
        preview: {classList: {remove() {}}}
    });

    return {
        pipeline, sandbox, timers, eventListeners,
        setStructureNodes(nodes) { structureNodes = nodes; }
    };
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

function makeMountedElement(runtime, attributes = {}, value = '') {
    const node = new runtime.sandbox.Element();
    node.attributes = {...attributes};
    node.children = [];
    node.parentElement = null;
    node.isConnected = true;
    node.textReads = 0;
    node.value = value;
    Object.defineProperties(node, {
        innerText: {get() { this.textReads += 1; return this.value; }},
        textContent: {get() { this.textReads += 1; return this.value; }}
    });
    node.getAttribute = name => node.attributes[name] ?? null;
    node.matches = selector => {
        if (selector === '[data-user-message-bubble="true"]') {
            return node.attributes['data-user-message-bubble'] === 'true';
        }
        if (selector === '[data-chatgpt-selection-message-id]') {
            return Boolean(node.attributes['data-chatgpt-selection-message-id']);
        }
        if (selector === '[data-turn-key]') return Boolean(node.attributes['data-turn-key']);
        if (selector === '[data-content-search-turn-key]') {
            return Boolean(node.attributes['data-content-search-turn-key']);
        }
        if (selector.includes('data-content-search-unit-key')) {
            return Boolean(node.attributes['data-content-search-unit-key'] ||
                node.attributes['data-chatgpt-search-unit-key']);
        }
        return false;
    };
    node.closest = selector => {
        for (let current = node; current; current = current.parentElement) {
            if (current.matches(selector)) return current;
        }
        return null;
    };
    node.contains = target => target === node || node.children.some(child => child.contains(target));
    node.querySelectorAll = selector => {
        const descendants = [];
        const visit = current => {
            for (const child of current.children) {
                if (child.matches(selector)) descendants.push(child);
                visit(child);
            }
        };
        visit(node);
        return descendants;
    };
    node.querySelector = selector => node.querySelectorAll(selector)[0] || null;
    node.append = child => {
        child.parentElement = node;
        node.children.push(child);
    };
    return node;
}

function makeBar(identity) {
    return {
        dataset: {ywIdentity: identity},
        attributes: {},
        setAttribute(name, value) { this.attributes[name] = value; }
    };
}

function prepareContentFixture(runtime) {
    const metrics = prepareRenderer(runtime);
    const {pipeline} = runtime;
    pipeline.setStub('captureUserEditCandidatesFromMutation', () => {});
    pipeline.setStub('replyOutlineHeaderMayHaveChanged', () => false);
    pipeline.setStub('isReplySidebarMutation', () => false);
    pipeline.setStub('invalidateThreadLayout', () => {});
    pipeline.setStub('scheduleNativeSnapshotRefresh', () => {});
    const root = makeMountedElement(runtime, {'data-turn-key': 'turn-one'});
    const bubble = makeMountedElement(runtime, {
        'data-user-message-bubble': 'true',
        'data-chatgpt-search-message-ids': 'question-id'
    }, 'new question');
    const paired = makeMountedElement(runtime, {
        'data-content-search-unit-key': 'paired:assistant',
        'data-chatgpt-search-message-ids': 'paired-id',
        'data-chatgpt-selection-message-id': 'paired-id'
    }, 'new paired answer');
    root.append(bubble);
    root.append(paired);
    const standalone = makeMountedElement(runtime, {
        'data-content-search-unit-key': 'standalone:assistant',
        'data-chatgpt-search-message-ids': 'answer-id',
        'data-chatgpt-selection-message-id': 'answer-id'
    }, 'new answer');
    const untouched = makeMountedElement(runtime, {
        'data-content-search-unit-key': 'untouched:assistant',
        'data-chatgpt-search-message-ids': 'untouched-id',
        'data-chatgpt-selection-message-id': 'untouched-id'
    }, 'untouched');
    const observedUser = {
        identity: 'user:turn-one', kind: 'user', stableIdentity: true,
        root, userBubble: bubble, pairedAssistantUnits: [paired],
        pairedAssistantIdentities: ['assistant:paired-id']
    };
    const observedAssistant = {
        identity: 'assistant:standalone', kind: 'assistant', stableIdentity: true,
        root: standalone, assistantUnit: standalone
    };
    const observedUntouched = {
        identity: 'assistant:untouched', kind: 'assistant', stableIdentity: true,
        root: untouched, assistantUnit: untouched
    };
    const snapshot = {
        chatId: 'chat', branchKey: 'branch',
        entries: [
            {identity: 'native-user', kind: 'user', turnKey: 'turn-one',
                userMessageId: 'question-id', assistantMessageIds: ['paired-id'],
                userText: 'old question', assistantText: 'old paired answer'},
            {identity: 'native-assistant', kind: 'assistant', messageId: 'answer-id',
                assistantMessageIds: ['answer-id'], assistantText: 'old answer'},
            {identity: 'native-untouched', kind: 'assistant', messageId: 'untouched-id',
                assistantMessageIds: ['untouched-id'], assistantText: 'untouched'}
        ]
    };
    assert.equal(pipeline.acceptNativeSnapshot(snapshot), true);
    pipeline.cancelRebuildSchedule();
    const store = pipeline.getTurnRecordStore('conversation:chat');
    const rendered = store.index.getEntries();
    const bars = rendered.map(turn => makeBar(turn.identity));
    pipeline.setMountedAndRenderedTurns([
        ['native-user', observedUser],
        ['native-assistant', observedAssistant],
        ['native-untouched', observedUntouched]
    ], rendered);
    pipeline.setRenderElements({
        barList: {children: bars, replaceChildren() { this.children = []; }},
        rail: {style: {}},
        preview: {classList: {remove() {}}}
    });
    pipeline.observeChatChanges();
    return {metrics, store, bars, root, bubble, paired, standalone, untouched, observedUser, snapshot};
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

test('a DOM body update after a native snapshot flushes one authoritative record', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, timers} = runtime;
    const {metrics, store, bars, bubble, snapshot} = prepareContentFixture(runtime);
    const record = store.byIdentity.get('native-user');

    assert.equal(pipeline.acceptNativeSnapshot({
        ...snapshot,
        entries: snapshot.entries.map((entry, index) => index === 0
            ? {...entry, userText: 'native after snapshot'}
            : entry)
    }), true);
    bubble.value = 'DOM after snapshot';
    pipeline.observerCallback([{
        type: 'characterData',
        target: {parentElement: bubble},
        addedNodes: [],
        removedNodes: []
    }]);
    assert.equal(metrics.collectCount, 0);

    timers.advance(0);

    assert.equal(metrics.collectCount, 0);
    assert.strictEqual(store.byIdentity.get('native-user'), record);
    assert.equal(record.userText, 'DOM after snapshot');
    assert.match(bars[0].attributes['aria-label'], /DOM after snapshot/);
});

test('a branch rebuild supersedes a queued native body projection', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, timers} = runtime;
    const {metrics, snapshot} = prepareContentFixture(runtime);

    assert.equal(pipeline.acceptNativeSnapshot({
        ...snapshot,
        entries: snapshot.entries.map((entry, index) => index === 0
            ? {...entry, userText: 'native body update'}
            : entry)
    }), true);
    assert.equal(pipeline.acceptNativeSnapshot({
        ...snapshot,
        branchKey: 'next-branch'
    }), true);
    assert.equal(pipeline.state.rebuildDirty, true);

    timers.advance(0);

    assert.equal(metrics.collectCount, 1);
    assert.equal(pipeline.state.rebuildDirty, false);
});

test('unclassified mutations and idle polls do not scan turns or read message text', () => {
    const runtime = loadPipelineRuntime();
    const metrics = prepareRenderer(runtime);
    const {pipeline, timers} = runtime;
    const renderCalls = pipeline.wrapRender();
    let locatorRetries = 0;
    let adapterRetries = 0;
    pipeline.setStub('retryNativeLocatorBinding', () => { locatorRetries += 1; });
    pipeline.setStub('retryNativeAdapterBinding', () => { adapterRetries += 1; });
    pipeline.setStub('getChatIdentity', () => 'conversation:chat');
    runtime.setStructureNodes([{
        getAttribute() { return null; },
        get innerText() { throw new Error('Idle polling read message text'); },
        get textContent() { throw new Error('Idle polling read message text'); }
    }]);
    pipeline.renderTurns();
    pipeline.startFallbackPolling();

    fireUnclassifiedMutation(pipeline);
    assert.equal(pipeline.state.rebuildDirty, false);
    assert.equal(pipeline.state.rebuildTimer, null);
    timers.advance(10000);
    assert.equal(renderCalls.length, 1);
    assert.equal(metrics.collectCount, 1);
    assert.equal(locatorRetries, 4);
    assert.equal(adapterRetries, 4);
});

test('fingerprint recovers unobserved identity changes and same-identity node replacements', () => {
    const runtime = loadPipelineRuntime();
    const metrics = prepareRenderer(runtime);
    const {pipeline, timers} = runtime;
    pipeline.setStub('getChatIdentity', () => 'conversation:chat');
    const makeNode = id => ({
        id,
        getAttribute(name) { return name === 'data-message-id' ? this.id : null; },
        get innerText() { throw new Error('Fingerprint read message text'); },
        get textContent() { throw new Error('Fingerprint read message text'); }
    });
    const node = makeNode('old');
    runtime.setStructureNodes([node]);
    const renderCalls = pipeline.wrapRender();
    pipeline.renderTurns();
    pipeline.startFallbackPolling();

    node.id = 'new';
    timers.advance(2500);
    assert.equal(renderCalls.length, 1);
    assert.equal(pipeline.state.rebuildDirty, true);
    timers.advance(180);
    assert.equal(renderCalls.length, 2);

    runtime.setStructureNodes([makeNode('new')]);
    timers.advance(2320);
    assert.equal(pipeline.state.rebuildDirty, true);
    timers.advance(180);
    assert.equal(renderCalls.length, 3);
    assert.equal(metrics.collectCount, 3);

    timers.advance(5000);
    assert.equal(renderCalls.length, 3);
});

test('streaming content updates only affected authoritative records and labels', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, timers} = runtime;
    const fixture = prepareContentFixture(runtime);
    const {metrics, store, bars, bubble, paired, standalone, untouched} = fixture;
    const initialEntries = store.index.getEntries();
    pipeline.observerCallback([
        {type: 'characterData', target: {parentElement: bubble}, addedNodes: [], removedNodes: []},
        {type: 'characterData', target: {parentElement: paired}, addedNodes: [], removedNodes: []},
        {type: 'characterData', target: {parentElement: standalone}, addedNodes: [], removedNodes: []},
        {type: 'childList', target: standalone,
            addedNodes: [makeMountedElement(runtime)], removedNodes: []}
    ]);

    assert.equal(pipeline.state.rebuildDirty, false);
    timers.advance(249);
    assert.equal(bubble.textReads + paired.textReads + standalone.textReads, 0);
    timers.advance(1);

    const entries = store.index.getEntries();
    assert.equal(metrics.collectCount, 0);
    assert.equal(entries[0].userText, 'new question');
    assert.equal(entries[0].assistantText, 'new paired answer');
    assert.equal(entries[1].assistantText, 'new answer');
    assert.strictEqual(store.byIdentity.get('native-user'), entries[0]);
    assert.strictEqual(store.turns[0], entries[0]);
    assert.strictEqual(entries[2], initialEntries[2]);
    assert.equal(bubble.textReads, 1);
    assert.equal(paired.textReads, 1);
    assert.equal(standalone.textReads, 1);
    assert.equal(untouched.textReads, 0);
    assert.match(bars[0].attributes['aria-label'], /new question/);
    assert.match(bars[1].attributes['aria-label'], /new answer/);
    assert.equal(pipeline.state.rebuildDirty, false);
});

test('native text-only snapshots refresh affected labels without collecting turns', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, timers} = runtime;
    const {metrics, store, bars, snapshot, bubble, paired, standalone, untouched} =
        prepareContentFixture(runtime);
    pipeline.unmountTurn('native-untouched');
    assert.equal(pipeline.acceptNativeSnapshot(snapshot), true);
    assert.equal(pipeline.state.contentRefreshTimer, null);
    assert.equal(pipeline.state.rebuildDirty, false);

    const next = {
        ...snapshot,
        entries: snapshot.entries.map((entry, index) => ({
            ...entry,
            ...(index === 0 ? {userText: 'native question'} : {}),
            ...(index === 2 ? {assistantText: 'native unmounted answer'} : {})
        }))
    };
    assert.equal(pipeline.acceptNativeSnapshot(next), true);
    assert.equal(pipeline.state.rebuildDirty, false);
    timers.advance(0);

    const entries = store.index.getEntries();
    assert.equal(metrics.collectCount, 0);
    assert.equal(entries[0].userText, 'new question');
    assert.equal(entries[2].assistantText, 'native unmounted answer');
    assert.match(bars[0].attributes['aria-label'], /new question/);
    assert.match(bars[2].attributes['aria-label'], /native unmounted answer/);
    assert.equal(bubble.textReads, 1);
    assert.equal(paired.textReads, 1);
    assert.equal(standalone.textReads, 0);
    assert.equal(untouched.textReads, 0);
});

test('a native branch change with unchanged identities still rebuilds', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, timers} = runtime;
    const {metrics, snapshot} = prepareContentFixture(runtime);
    assert.equal(pipeline.acceptNativeSnapshot({...snapshot, branchKey: 'other-branch'}), true);
    assert.equal(pipeline.state.rebuildDirty, true);
    timers.advance(0);
    assert.equal(metrics.collectCount, 1);
});

test('a pending user edit uses the full branch reconciliation path', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, timers} = runtime;
    const {metrics, bubble} = prepareContentFixture(runtime);
    pipeline.setEditCandidate('native-user');
    pipeline.observerCallback([{
        type: 'characterData', target: {parentElement: bubble},
        addedNodes: [], removedNodes: []
    }]);
    assert.equal(pipeline.state.rebuildDirty, true);
    timers.advance(180);
    assert.equal(metrics.collectCount, 1);
});

test('an unresolved mounted record falls back to one full rebuild', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, timers} = runtime;
    const {metrics, store, standalone} = prepareContentFixture(runtime);
    store.byIdentity.delete('native-assistant');
    pipeline.observerCallback([{
        type: 'characterData', target: {parentElement: standalone},
        addedNodes: [], removedNodes: []
    }]);
    timers.advance(250);
    assert.equal(pipeline.state.rebuildDirty, true);
    assert.equal(metrics.collectCount, 0);
    timers.advance(180);
    assert.equal(metrics.collectCount, 1);
    timers.advance(2500);
    assert.equal(metrics.collectCount, 1);
});

test('route changes discard a pending content refresh from the previous conversation', () => {
    const runtime = loadPipelineRuntime();
    const {pipeline, sandbox, timers} = runtime;
    const {metrics, store, standalone} = prepareContentFixture(runtime);
    prepareRouteEffects(pipeline);
    pipeline.observerCallback([{
        type: 'characterData', target: {parentElement: standalone},
        addedNodes: [], removedNodes: []
    }]);
    sandbox.window.location.pathname = '/c/new';
    pipeline.handleRouteChange();
    timers.advance(250);

    assert.equal(store.index.getEntries()[1].assistantText, 'old answer');
    assert.equal(standalone.textReads, 0);
    assert.equal(metrics.collectCount, 1);
    assert.equal(pipeline.state.currentChatIdentity, 'conversation:new');
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
    for (const name of [
        'data-chatgpt-search-message-ids',
        'data-chatgpt-selection-message-id',
        'data-message-id'
    ]) {
        assert.equal(pipeline.observerOptions.attributeFilter.includes(name), true);
    }

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
