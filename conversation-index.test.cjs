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

test('a new branch releases present entries but keeps absent old entries hidden', () => {
    const index = createConversationIndex();
    const original = [
        {identity: 'first', kind: 'user', userMessageId: 'user-first'},
        {identity: 'second', kind: 'user', userMessageId: 'user-second'},
        {identity: 'removed', kind: 'user', userMessageId: 'user-removed'}
    ];
    index.applySnapshot({branchKey: 'old-branch', entries: original});
    index.pruneFrom('second');

    const result = index.applySnapshot({
        branchKey: 'new-branch',
        entries: original.slice(0, 2)
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(
        index.getEntries().map(entry => entry.identity),
        ['first', 'second']
    );

    index.upsertObserved({
        identity: 'second',
        kind: 'user',
        userMessageId: 'user-second',
        userText: 'restored branch'
    });
    index.upsertObserved({
        identity: 'removed',
        kind: 'user',
        userMessageId: 'user-removed',
        userText: 'stale old branch'
    });
    assert.deepEqual(
        index.getEntries().map(entry => entry.identity),
        ['first', 'second']
    );
    assert.equal(index.getEntries()[1].userText, 'restored branch');
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

test('updating a shared record reindexes the aliases captured before mutation', () => {
    const index = createConversationIndex();
    const entries = index.upsertObserved({
        identity: 'turn', kind: 'user', messageId: 'before'
    });
    const record = entries[0];
    record.messageId = 'after';
    index.upsertObserved(record);

    assert.equal(index.getEntries(), entries);
    assert.equal(index.getEntries()[0], record);
    assert.equal(index.resolveEntry({identity: 'probe', messageId: 'before'}), null);
    assert.equal(index.resolveEntry({identity: 'probe', messageId: 'after'}), record);
});

test('snapshot rekey preserves the record and committed edit through the new identity', () => {
    const index = createConversationIndex();
    const entries = index.upsertObserved({
        identity: 'old', kind: 'user', turnKey: 'round', userText: 'before'
    });
    const record = entries[0];
    index.pruneFrom('old', {keepIdentity: true, userText: 'edited'});

    const result = index.applySnapshot({branchKey: 'branch', entries: [{
        identity: 'new', kind: 'user', turnKey: 'round', userText: 'before'
    }]});
    assert.equal(result.accepted, true);
    assert.deepEqual(result.identityChanges, [{oldIdentity: 'old', identity: 'new'}]);
    assert.equal(index.getEntries(), entries);
    assert.equal(entries[0], record);
    assert.equal(record.userText, 'edited');
    assert.equal(index.resolveEntry({identity: 'old'}), null);
    assert.equal(index.resolveEntry({identity: 'new'}), record);
});

test('a stale snapshot after a confirmed edit cannot overwrite committed text', () => {
    const index = createConversationIndex();
    index.upsertObserved({identity: 'user:B', kind: 'user', turnKey: 'B', userText: 'before'});
    index.pruneFrom('user:B', {keepIdentity: true, userText: 'edited',
        domUserTextBaseline: 'edited'});
    const snapshot = userText => ({branchKey: 'branch', entries: [{
        identity: 'user:B', kind: 'user', turnKey: 'B', userText
    }]});

    assert.equal(index.applySnapshot(snapshot('edited')).accepted, true);
    assert.equal(index.applySnapshot(snapshot('before')).accepted, true);
    assert.equal(index.getEntries()[0].userText, 'edited');
    assert.equal(index.getEntries()[0].preserveCommittedUserText, true);
});

test('an alias shared across kinds resolves and updates the requested kind', () => {
    const index = createConversationIndex();
    index.applySnapshot({branchKey: 'branch', entries: [
        {identity: 'user', kind: 'user', messageId: 'shared'},
        {identity: 'assistant', kind: 'assistant', messageId: 'shared'}
    ]});
    const assistant = index.resolveEntry(
        {identity: 'probe', messageId: 'shared'}, {kind: 'assistant'}
    );
    assert.equal(assistant.identity, 'assistant');
    index.upsertObserved({identity: 'assistant-dom', kind: 'assistant',
        messageId: 'shared', assistantText: 'updated'});
    assert.equal(index.getEntries().length, 2);
    assert.equal(assistant.assistantText, 'updated');
    assert.equal(index.getEntries()[0].assistantText, undefined);
});
