const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadCacheRuntime() {
    const filename = require.resolve('./chatgpt-conversation-navigator.user.js');
    const source = fs.readFileSync(filename, 'utf8');
    class Element {
        constructor() { this.isConnected = true; }
        querySelectorAll() { return []; }
        matches() { return false; }
    }
    const context = vm.createContext({
        Element,
        document: {readyState: 'loading', addEventListener() {}},
        window: {location: {pathname: '/c/initial'}},
        console, setTimeout, clearTimeout
    });
    const end = source.lastIndexOf('\n})();');
    vm.runInContext(source.slice(0, end) + `
        globalThis.cacheTest = {
            setCurrent(identity) { currentChatIdentity = identity; },
            getStore: getTurnRecordStore,
            getIndex: getConversationIndex,
            remember: rememberTurnIdentity,
            track: trackCurrentRouteTurn,
            release: releaseConversationDOM,
            transfer: transferChatTurnIdentities,
            limit: MAX_CACHED_CONVERSATIONS,
            stats() {
                return {
                    chats: Array.from(turnRecordsByChat.keys()),
                    identityChats: Array.from(turnIdentitiesByChat.keys()),
                    owners: Array.from(chatOwnersByTurnIdentity, ([id, owners]) =>
                        [id, Array.from(owners)])
                };
            }
        };
    ` + source.slice(end), context, {filename});
    return {runtime: context.cacheTest, Element};
}

test('conversation cache evicts the oldest inactive chat and its reverse owners', () => {
    const {runtime} = loadCacheRuntime();
    runtime.setCurrent('current');
    const current = runtime.getStore('current');
    runtime.remember('current', 'current-message');
    for (let i = 0; i < runtime.limit + 2; i++) {
        runtime.getStore(`chat-${i}`);
        runtime.remember(`chat-${i}`, `message-${i}`);
    }
    assert.equal(runtime.stats().chats.length, runtime.limit);
    assert.equal(runtime.getStore('current'), current);
    assert.ok(!runtime.stats().chats.includes('chat-0'));
    assert.ok(!runtime.stats().identityChats.includes('chat-0'));
    assert.ok(!runtime.stats().owners.some(([id]) => id === 'message-0'));
    assert.ok(runtime.stats().owners.some(([id]) => id === 'current-message'));
});

test('recently revisited chats keep their logical index and eviction releases DOM references', () => {
    const {runtime, Element} = loadCacheRuntime();
    runtime.setCurrent('first');
    const first = runtime.getStore('first');
    const record = {identity: 'old-turn', root: new Element(),
        userBubble: new Element(), assistantUnit: new Element()};
    first.turns.push(record);
    first.byIdentity.set(record.identity, record);
    first.index.upsertObserved({identity: record.identity, kind: 'assistant'});
    runtime.release('first');
    assert.equal(record.root, null);
    assert.equal(record.userBubble, null);
    assert.equal(record.assistantUnit, null);
    runtime.setCurrent('second');
    runtime.getStore('second');
    runtime.setCurrent('first');
    assert.equal(runtime.getStore('first'), first);
    assert.equal(runtime.getIndex('first'), first.index);
    assert.equal(first.index.getEntries().length, 1);
    runtime.setCurrent('other');
    runtime.getStore('other');
    for (let i = 0; i < runtime.limit; i++) runtime.getStore(`new-${i}`);
    assert.ok(!runtime.stats().chats.includes('first'));
    assert.equal(runtime.getStore('first').index.getEntries().length, 0);
});

test('eviction preserves weak ownership of stale mounted nodes without blocking node reuse', () => {
    const {runtime, Element} = loadCacheRuntime();
    const root = new Element();
    const oldTurn = {identity: 'old-turn', kind: 'assistant',
        stableIdentity: true, root};
    runtime.setCurrent('old');
    runtime.getStore('old');
    assert.equal(runtime.track(oldTurn), true);
    runtime.setCurrent('new');
    runtime.getStore('new');
    for (let i = 0; i < runtime.limit; i++) runtime.getStore(`fill-${i}`);
    assert.ok(!runtime.stats().chats.includes('old'));
    assert.equal(runtime.track(oldTurn), false);
    assert.equal(runtime.track({...oldTurn, identity: 'new-turn'}), true);
});

test('new-conversation promotion transfers the shared index and identity ownership before eviction', () => {
    const {runtime, Element} = loadCacheRuntime();
    runtime.setCurrent('route:/');
    const source = runtime.getStore('route:/');
    // This node has been observed but its deferred projection has not run yet.
    const observed = {identity: 'pending-turn', kind: 'assistant',
        stableIdentity: true, root: new Element()};
    assert.equal(runtime.track(observed), true);
    source.index.upsertObserved({identity: 'promoted-turn', kind: 'user',
        userMessageId: 'promoted-message'});
    runtime.remember('route:/', 'promoted-turn');
    const target = 'conversation:promoted';
    runtime.transfer('route:/', target);
    runtime.setCurrent(target);
    assert.equal(runtime.track(observed), true);
    const store = runtime.getStore(target);
    assert.equal(runtime.getIndex(target), store.index);
    assert.equal(store.index.getEntries()[0].identity, 'promoted-turn');
    assert.ok(!runtime.stats().chats.includes('route:/'));
    const [, owners] = runtime.stats().owners.find(([id]) => id === 'promoted-turn');
    assert.deepEqual(Array.from(owners), [target]);
});
