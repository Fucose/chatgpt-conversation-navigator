const test = require('node:test');
const assert = require('node:assert/strict');
const {createConversationIndex} = require('./chatgpt-conversation-navigator.user.js');

test('upserted aliases are available to later records in the same batch', () => {
    const index = createConversationIndex();

    const entries = index.upsertObserved([
        {
            identity: 'first',
            kind: 'user',
            userMessageId: 'shared-user',
            messageId: 'user-message',
            userText: 'question'
        },
        {
            identity: 'alias-introducer',
            kind: 'user',
            userMessageId: 'shared-user',
            messageId: 'new-alias'
        },
        {
            identity: 'alias-consumer',
            kind: 'user',
            messageId: 'new-alias',
            assistantText: 'answer'
        }
    ]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0].identity, 'first');
    assert.equal(entries[0].assistantText, 'answer');
});

test('removing a winning alias promotes the earliest remaining conflict', () => {
    const index = createConversationIndex();
    index.applySnapshot({
        branchKey: 'branch',
        entries: [
            {identity: 'first', kind: 'user', messageId: 'shared'},
            {identity: 'second', kind: 'user', messageId: 'shared'}
        ]
    });

    assert.equal(
        index.resolveEntry({identity: 'probe', messageId: 'shared'}).identity,
        'first'
    );
    index.upsertObserved({
        identity: 'first',
        kind: 'user',
        messageId: 'first-updated'
    });

    assert.equal(
        index.resolveEntry({identity: 'probe', messageId: 'shared'}).identity,
        'second'
    );
    index.upsertObserved({
        identity: 'third',
        kind: 'user',
        messageId: 'shared',
        observed: true
    });
    assert.equal(index.getEntries().length, 2);
    assert.equal(index.getEntries()[1].identity, 'second');
    assert.equal(index.getEntries()[1].observed, true);
});

test('observed batch order and snapshot order are retained across rebuilds', () => {
    const index = createConversationIndex();
    index.upsertObserved([
        {identity: 'first', kind: 'user', userMessageId: 'user-first'},
        {identity: 'second', kind: 'user', userMessageId: 'user-second'},
        {identity: 'third', kind: 'user', userMessageId: 'user-third'}
    ]);

    index.upsertObserved([
        {identity: 'third', kind: 'user', userText: 'third update'},
        {identity: 'second', kind: 'user', userText: 'second update'}
    ]);
    assert.deepEqual(
        index.getEntries().map(entry => entry.identity),
        ['third', 'second', 'first']
    );

    index.applySnapshot({
        branchKey: 'branch',
        entries: [
            {identity: 'first', kind: 'user', userMessageId: 'user-first'},
            {identity: 'second', kind: 'user', userMessageId: 'user-second'}
        ]
    });
    assert.deepEqual(
        index.getEntries().map(entry => entry.identity),
        ['first', 'second']
    );
    assert.equal(index.retire('first'), true);
    assert.deepEqual(
        index.getEntries().map(entry => entry.identity),
        ['second']
    );
    assert.equal(
        index.resolveEntry({identity: 'probe', userMessageId: 'user-second'}).identity,
        'second'
    );
});

test('snapshot assistant message IDs replace the previous ID set', () => {
    const index = createConversationIndex();
    index.applySnapshot({
        branchKey: 'branch',
        entries: [{
            identity: 'turn',
            kind: 'user',
            userMessageId: 'user-message',
            assistantMessageIds: ['old-assistant']
        }]
    });
    index.applySnapshot({
        branchKey: 'branch',
        entries: [{
            identity: 'turn',
            kind: 'user',
            userMessageId: 'user-message',
            assistantMessageIds: ['new-assistant']
        }]
    });

    assert.equal(
        index.resolveEntry({identity: 'old-probe', messageId: 'old-assistant'}),
        null
    );
    assert.equal(
        index.resolveEntry({identity: 'new-probe', messageId: 'new-assistant'}).identity,
        'turn'
    );
});

test('pruning suppresses a stale snapshot from restoring removed entries', () => {
    const index = createConversationIndex();
    const original = [
        {identity: 'first', kind: 'user', userMessageId: 'user-first'},
        {identity: 'edited', kind: 'user', userMessageId: 'user-edited'},
        {identity: 'later', kind: 'user', userMessageId: 'user-later'}
    ];
    index.applySnapshot({branchKey: 'branch', entries: original});

    const removed = index.pruneFrom('edited', {keepIdentity: true});
    assert.deepEqual(removed.map(entry => entry.identity), ['later']);
    assert.equal(
        index.applySnapshot({branchKey: 'branch', entries: original}).accepted,
        false
    );
    assert.deepEqual(
        index.getEntries().map(entry => entry.identity),
        ['first', 'edited']
    );
});

test('committed user text survives a snapshot with stale text baselines', () => {
    const index = createConversationIndex();
    index.applySnapshot({
        branchKey: 'branch',
        entries: [{
            identity: 'edited',
            kind: 'user',
            userMessageId: 'user-edited',
            userText: 'before edit',
            userTextSnapshot: 'before edit',
            domUserTextBaseline: 'before edit'
        }]
    });
    index.pruneFrom('edited', {
        keepIdentity: true,
        userText: 'committed edit',
        domUserTextBaseline: 'committed baseline'
    });

    index.applySnapshot({
        branchKey: 'branch',
        entries: [{
            identity: 'edited',
            kind: 'user',
            userMessageId: 'user-edited',
            userText: 'before edit',
            userTextSnapshot: 'before edit',
            domUserTextBaseline: 'before edit'
        }]
    });

    assert.equal(index.getEntries()[0].userText, 'committed edit');
    assert.equal(
        index.getEntries()[0].userTextSnapshot,
        'committed edit'
    );
    assert.equal(
        index.getEntries()[0].domUserTextBaseline,
        'committed baseline'
    );
});

test('partial virtualized observations retain the authoritative window', () => {
    const index = createConversationIndex();
    index.applySnapshot({
        branchKey: 'branch',
        entries: [
            {identity: 'first', kind: 'user', userMessageId: 'user-first'},
            {identity: 'middle', kind: 'user', userMessageId: 'user-middle'},
            {identity: 'last', kind: 'user', userMessageId: 'user-last'}
        ]
    });
    const firstEntry = index.getEntries()[0];
    const lastEntry = index.getEntries()[2];

    index.upsertObserved([{
        identity: 'middle',
        kind: 'user',
        userText: 'observed update'
    }]);

    assert.deepEqual(
        index.getEntries().map(entry => entry.identity),
        ['first', 'middle', 'last']
    );
    assert.equal(index.getEntries()[0], firstEntry);
    assert.equal(index.getEntries()[2], lastEntry);
    assert.equal(index.getEntries()[1].userText, 'observed update');
});

test('resolve and batched upserts do not rescan indexed entries', () => {
    const index = createConversationIndex();
    const initialEntries = Array.from({length: 40}, (_, i) => ({
        identity: `initial-${i}`,
        kind: 'user',
        userMessageId: `initial-user-${i}`
    }));
    index.applySnapshot({branchKey: 'branch', entries: initialEntries});

    let identityReads = 0;
    const firstEntry = index.getEntries()[0];
    Object.defineProperty(firstEntry, 'identity', {
        configurable: true,
        get() {
            identityReads += 1;
            return 'initial-0';
        }
    });

    for (let i = 0; i < 20; i += 1) {
        assert.equal(
            index.resolveEntry({identity: `missing-${i}`}),
            null
        );
    }
    index.upsertObserved(Array.from({length: 120}, (_, i) => ({
        identity: `batch-${i}`,
        kind: 'user',
        userMessageId: `batch-user-${i}`
    })));

    assert.equal(identityReads, 0);
    assert.equal(index.getEntries().length, 160);
});

test('public rebuildAliases synchronizes explicit entry mutations', () => {
    const index = createConversationIndex();
    const [entry] = index.upsertObserved({
        identity: 'turn',
        kind: 'user',
        messageId: 'before'
    });
    entry.messageId = 'after';

    index.rebuildAliases();

    assert.equal(
        index.resolveEntry({identity: 'old-probe', messageId: 'before'}),
        null
    );
    assert.equal(
        index.resolveEntry({identity: 'new-probe', messageId: 'after'}),
        entry
    );
});
