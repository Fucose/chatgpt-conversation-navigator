const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadStoreRuntime() {
    const filename = require.resolve('./chatgpt-conversation-navigator.user.js');
    const source = fs.readFileSync(filename, 'utf8');

    class Element {
        constructor(attributes = {}, text = '') {
            this.attributes = attributes;
            this.innerText = text;
            this.textContent = text;
            this.children = [];
            this.parentElement = null;
            this.isConnected = true;
        }
        append(child) {
            child.parentElement = this;
            this.children.push(child);
            return child;
        }
        getAttribute(name) { return this.attributes[name] ?? null; }
        matches(selector) {
            return selector.split(',').some(part => {
                const checks = Array.from(part.trim().matchAll(/\[([\w-]+)(?:([*$]?=)"([^"]*)")?\]/g));
                return checks.length > 0 && checks.every(([, name, operator, expected]) => {
                    const value = this.getAttribute(name);
                    if (!operator) return value !== null;
                    if (value === null) return false;
                    if (operator === '$=') return value.endsWith(expected);
                    if (operator === '*=') return value.includes(expected);
                    return value === expected;
                });
            });
        }
        closest(selector) {
            for (let node = this; node; node = node.parentElement) {
                if (node.matches(selector)) return node;
            }
            return null;
        }
        contains(node) {
            for (let current = node; current; current = current.parentElement) {
                if (current === this) return true;
            }
            return false;
        }
        querySelectorAll(selector) {
            const results = [];
            const visit = node => {
                for (const child of node.children) {
                    if (child.matches(selector)) results.push(child);
                    visit(child);
                }
            };
            visit(this);
            return results;
        }
        querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    }

    const window = {location: {pathname: '/c/chat'}};
    const context = vm.createContext({
        Element, window,
        document: {readyState: 'loading', addEventListener() {}},
        console, setTimeout, clearTimeout
    });
    const end = source.lastIndexOf('\n})();');
    vm.runInContext(source.slice(0, end) + `
        globalThis.storeTest = {
            setCurrent(identity) {
                currentChatIdentity = identity;
                window.location.pathname = identity.startsWith('conversation:')
                    ? '/c/' + identity.slice('conversation:'.length) : '/';
            },
            store: getTurnRecordStore,
            snapshot: applyNativeSnapshot,
            snapshotChanges: applyNativeSnapshotWithChanges,
            observe(observed) { mergeObservedTurnRecords(observed, true, true, true); },
            render: buildRenderedTurns,
            messageIds: getTurnMessageIds,
            userIdentity: getUserStableIdentity,
            previewText(turn) { return getAssistantText(turn); },
            refresh: updateObservedTurnContent,
            rememberEdit(turn) { rememberUserEditCandidate(turn, null); },
            candidate(identity) { return userEditCandidates.get(identity); },
            resolve: resolveRememberedIdentity,
            transfer: transferChatTurnIdentities,
            targetMessageId(identity) {
                const entry = getTurnRecordStore(currentChatIdentity).byIdentity.get(identity);
                return getEntryTargetMessageId(entry, {replyTop: true});
            }
        };
    ` + source.slice(end), context, {filename});

    function userTurn(identity, turnKey, userId, userText, assistantId, assistantText) {
        const root = new Element({'data-turn-key': turnKey});
        const userBubble = root.append(new Element({
            'data-user-message-bubble': 'true',
            'data-chatgpt-search-message-ids': userId
        }, userText));
        const pairedAssistantUnits = [];
        if (assistantId) {
            const unit = root.append(new Element({
                'data-content-search-unit-key': `${turnKey}:assistant`,
                'data-chatgpt-search-message-ids': assistantId
            }, assistantText));
            unit.append(new Element({'data-chatgpt-selection-message-id': assistantId}, assistantText));
            pairedAssistantUnits.push(unit);
        }
        return {identity, turnKey, kind: 'user', stableIdentity: true,
            root, userBubble, pairedAssistantUnits};
    }

    function assistantTurn(identity, messageId, assistantText) {
        const unit = new Element({
            'data-chatgpt-search-unit-key': `assistant-${messageId}`,
            'data-chatgpt-search-message-ids': messageId
        }, assistantText);
        return {
            identity, kind: 'assistant', stableIdentity: true,
            root: unit, assistantUnit: unit, assistantText
        };
    }

    return {runtime: context.storeTest, userTurn, assistantTurn, Element};
}

function native(identity, turnKey, userId, userText, assistantIds = []) {
    return {identity, turnKey, kind: 'user', userMessageId: userId,
        messageId: userId, assistantMessageIds: assistantIds, userText};
}

function completedAssistant(entry, messageId, assistantText) {
    return {
        ...entry,
        assistantText,
        assistantTextSource: 'native-complete',
        assistantTextSourceMessageIds: [messageId],
        assistantTextUnresolvedReferenceMessageIds: []
    };
}

test('DOM observation and a rekeyed native snapshot share one record and migrate aliases', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const observed = userTurn('user:dom', 'round-1', 'question-1', 'DOM question', 'answer-1', 'DOM answer');
    runtime.observe([observed]);
    const store = runtime.store('conversation:chat');
    const entries = store.index.getEntries();
    const record = store.byIdentity.get('user:dom');
    assert.equal(entries[0], record);
    assert.equal(store.turns[0], record);
    assert.equal(runtime.render([observed])[0], record);
    runtime.rememberEdit(observed);
    store.identityAliases.set('user:older', 'user:dom');
    store.pairedAssistantToUser.set('assistant:answer-1', 'user:dom');

    assert.equal(runtime.snapshot({chatId: 'chat', branchKey: 'branch', entries: [
        {...native('user:native', 'round-1', 'question-1', 'native question', ['answer-1']), assistantText: 'native answer'}
    ]}), true);

    assert.equal(store.index.getEntries(), entries);
    assert.equal(entries[0], record);
    assert.equal(store.turns[0], record);
    assert.equal(store.byIdentity.get('user:native'), record);
    assert.equal(store.byIdentity.has('user:dom'), false);
    assert.equal(runtime.resolve(store, 'user:dom'), 'user:native');
    assert.equal(runtime.resolve(store, 'user:older'), 'user:native');
    assert.equal(store.pairedAssistantToUser.get('assistant:answer-1'), 'user:native');
    assert.equal(runtime.candidate('user:native').identity, 'user:native');
    assert.equal(record.root, observed.root);
    assert.equal(record.userText, 'native question');
    assert.equal(record.assistantText, 'native answer');
});

test('nested user units retain wrapper message IDs in stable identities and stored observations', () => {
    const {runtime, Element} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const root = new Element({'data-content-search-turn-key': 'fallback-turn-5'});
    const outerUnit = root.append(new Element({
        'data-chatgpt-search-unit-key': 'fallback-turn-5:0:user',
        'data-chatgpt-search-message-ids': 'question-5'
    }));
    const innerUnit = outerUnit.append(new Element({
        'data-content-search-unit-key': 'fallback-turn-5:0:user'
    }));
    const userBubble = innerUnit.append(new Element({'data-user-message-bubble': 'true'}, 'Question five'));
    const identity = runtime.userIdentity(userBubble, root);
    const observed = {identity, kind: 'user', root, userBubble, stableIdentity: true};

    assert.equal(identity, 'user:question-5');
    assert.deepEqual(Array.from(runtime.messageIds(observed).userMessageIds), ['question-5']);
    runtime.observe([observed]);
    const record = runtime.store('conversation:chat').byIdentity.get(identity);
    assert.equal(record.userMessageId, 'question-5');
    assert.equal(record.messageId, 'question-5');
    assert.equal(record.userText, 'Question five');
    assert.equal(runtime.snapshot({chatId: 'chat', branchKey: 'branch', entries: [
        native('user:native-turn-5', 'native-turn-5', 'question-5', 'Question five')
    ]}), true);
    assert.equal(runtime.store('conversation:chat').byIdentity.get('user:native-turn-5'), record);
});

test('user wrapper ID lookup rejects assistant ancestors, generic parents, neighboring IDs and multiple bubbles', () => {
    const {runtime, Element} = loadStoreRuntime();
    for (const attributes of [
        {'data-chatgpt-search-unit-key': 'turn:assistant', 'data-chatgpt-search-message-ids': 'assistant-id'},
        {'data-chatgpt-search-message-ids': 'generic-parent-id'}
    ]) {
        const root = new Element(attributes);
        const userBubble = root.append(new Element({'data-user-message-bubble': 'true'}));
        assert.deepEqual(Array.from(runtime.messageIds({kind: 'user', root, userBubble}).userMessageIds), []);
    }

    const root = new Element({'data-turn-key': 'turn-1'});
    const neighboringUnit = root.append(new Element({
        'data-chatgpt-search-unit-key': 'turn-1:0:user',
        'data-chatgpt-search-message-ids': 'neighbor-id'
    }));
    neighboringUnit.append(new Element({'data-user-message-bubble': 'true'}));
    const ownUnit = root.append(new Element({'data-chatgpt-search-unit-key': 'turn-1:1:user'}));
    const userBubble = ownUnit.append(new Element({'data-user-message-bubble': 'true'}));
    assert.deepEqual(Array.from(runtime.messageIds({kind: 'user', root, userBubble}).userMessageIds), []);

    const carrier = new Element({
        'data-content-search-unit-key': 'turn-2:user',
        'data-chatgpt-search-message-ids': 'ambiguous-id'
    });
    const firstBubble = carrier.append(new Element({'data-user-message-bubble': 'true'}));
    carrier.append(new Element({'data-user-message-bubble': 'true'}));
    assert.deepEqual(Array.from(runtime.messageIds({userBubble: firstBubble}).userMessageIds), []);

    const outerUser = new Element({
        'data-chatgpt-search-unit-key': 'turn-3:user',
        'data-chatgpt-search-message-ids': 'outer-user-id'
    });
    const assistant = outerUser.append(new Element({'data-content-search-unit-key': 'turn-3:assistant'}));
    const nestedBubble = assistant.append(new Element({'data-user-message-bubble': 'true'}));
    assert.deepEqual(Array.from(runtime.messageIds({userBubble: nestedBubble}).userMessageIds), []);
});

test('assistant-only DOM units retain search message IDs after virtualization', () => {
    const {runtime, assistantTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const messageId = 'assistant-dil-message-42';
    const observed = assistantTurn(
        `assistant:${messageId}`,
        messageId,
        'Complete DIL response.\nTask paused'
    );
    runtime.observe([observed]);

    const store = runtime.store('conversation:chat');
    const record = store.byIdentity.get(`assistant:${messageId}`);
    const entries = store.index.getEntries();
    assert.equal(record.messageId, messageId);
    assert.deepEqual(Array.from(record.assistantMessageIds), [messageId]);
    assert.equal(runtime.targetMessageId(record.identity), messageId);

    observed.root.isConnected = false;
    runtime.observe([]);
    assert.equal(store.index.getEntries(), entries);
    assert.equal(store.index.getEntries()[0], record);
    assert.equal(record.messageId, messageId);
    assert.deepEqual(Array.from(record.assistantMessageIds), [messageId]);
    assert.equal(runtime.targetMessageId(record.identity), messageId);
});

test('virtualized observations preserve native branch order, hidden records and native aliases', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const snapshot = {chatId: 'chat', branchKey: 'branch', entries: [
        native('user:A', 'A', 'question-A', 'A', ['answer-A']),
        native('user:B', 'B', 'question-B', 'B', ['answer-B']),
        native('user:C', 'C', 'question-C', 'C', ['answer-C'])
    ]};
    assert.equal(runtime.snapshot(snapshot), true);
    const store = runtime.store('conversation:chat');
    const before = Array.from(store.index.getEntries());
    const b = userTurn('user:B', 'B', 'question-B', 'B streamed');
    const a = userTurn('user:A', 'A', 'question-A', 'A streamed');
    runtime.observe([b, a]);

    assert.deepEqual(Array.from(store.index.getEntries(), record => record.identity), ['user:A', 'user:B', 'user:C']);
    assert.deepEqual(Array.from(runtime.render([b, a]), record => record.identity), ['user:A', 'user:B', 'user:C']);
    assert.equal(store.index.getEntries()[2], before[2]);
    assert.equal(store.byIdentity.get('user:C'), before[2]);
    assert.equal(before[1].userText, 'B streamed');
    assert.equal(store.index.resolveEntry({identity: 'probe', messageId: 'answer-B'}), before[1]);
    assert.equal(before[2].root, null);
    assert.deepEqual(Array.from(store.turns, record => record.identity), ['user:A', 'user:B', 'user:C']);

    const unstableC = userTurn('fallback:C', 'fallback-turn-C', '', 'C');
    unstableC.stableIdentity = false;
    runtime.observe([a, b, unstableC]);
    assert.equal(unstableC.identity, 'user:C');
    assert.equal(unstableC.stableIdentity, true);
    assert.equal(store.byIdentity.get('user:C'), before[2]);
    assert.deepEqual(Array.from(runtime.render([a, b, unstableC]), record => record.identity), ['user:A', 'user:B', 'user:C']);
});

test('editing truncates the native branch and stale snapshots cannot restore removed records or text', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const snapshot = {chatId: 'chat', branchKey: 'branch', entries: [
        native('user:A', 'A', 'question-A', 'A'),
        native('user:B', 'B', 'question-B', 'before'),
        native('user:C', 'C', 'question-C', 'C')
    ]};
    runtime.snapshot(snapshot);
    const store = runtime.store('conversation:chat');
    const b = userTurn('user:B', 'B', 'question-B', 'before');
    const a = userTurn('user:A', 'A', 'question-A', 'A');
    runtime.observe([b, a]); // DOM order differs from the authoritative branch.
    runtime.rememberEdit(b);
    b.userBubble.innerText = b.userBubble.textContent = 'committed edit';
    runtime.observe([b, a]);

    assert.deepEqual(Array.from(store.index.getEntries(), record => record.identity), ['user:A', 'user:B']);
    assert.deepEqual(Array.from(store.turns, record => record.identity), ['user:A', 'user:B']);
    const record = store.byIdentity.get('user:B');
    assert.equal(record.userText, 'committed edit');
    assert.equal(store.byIdentity.has('user:C'), false);
    assert.equal(runtime.snapshot(snapshot), false);
    const staleC = userTurn('user:C', 'C', 'question-C', 'C');
    runtime.observe([staleC]);
    assert.equal(store.byIdentity.has('user:C'), false);
    assert.equal(runtime.snapshot({...snapshot, entries: snapshot.entries.slice(0, 2)}), true);
    assert.equal(store.byIdentity.get('user:B'), record);
    assert.equal(record.userText, 'committed edit');
    assert.equal(record.userTextSnapshot, 'committed edit');
    b.userBubble.innerText = b.userBubble.textContent = 'before';
    assert.equal(runtime.refresh(b), record);
    assert.equal(record.userText, 'committed edit');

    const confirmed = {...snapshot, entries: [snapshot.entries[0],
        {...snapshot.entries[1], userText: 'committed edit'}]};
    assert.equal(runtime.snapshot(confirmed), true);
    assert.equal(record.preserveCommittedUserText, true);
    assert.equal(runtime.snapshot({...snapshot, entries: snapshot.entries.slice(0, 2)}), true);
    assert.equal(record.userText, 'committed edit');
});

test('a confirmed branch switch restores entries removed by the old branch edit', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const oldBranch = {chatId: 'chat', branchKey: 'old-branch', entries: [
        native('user:A', 'A', 'question-A', 'A'),
        native('user:B', 'B', 'question-B', 'B')
    ]};
    runtime.snapshot(oldBranch);
    const a = userTurn('user:A', 'A', 'question-A', 'A');
    const b = userTurn('user:B', 'B', 'question-B', 'B');
    runtime.observe([a, b]);
    runtime.rememberEdit(a);
    a.userBubble.innerText = a.userBubble.textContent = 'A edited';
    runtime.observe([a]);

    const store = runtime.store('conversation:chat');
    assert.equal(store.byIdentity.has('user:B'), false);
    assert.equal(store.suppressedRemovedIdentities.has('user:B'), true);

    const newBranch = {
        ...oldBranch,
        branchKey: 'new-branch',
        entries: oldBranch.entries.map(entry => entry.identity === 'user:A'
            ? {...entry, userText: 'A edited'}
            : entry)
    };
    assert.equal(runtime.snapshot(newBranch), true);
    assert.equal(store.byIdentity.has('user:B'), true);
    assert.equal(store.suppressedRemovedIdentities.has('user:B'), false);

    runtime.observe([a, b]);
    assert.deepEqual(
        Array.from(store.index.getEntries(), record => record.identity),
        ['user:A', 'user:B']
    );
});

test('promotion into an existing store keeps canonical record references and transfers identity aliases', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:promoted');
    runtime.snapshot({chatId: 'promoted', branchKey: 'branch', entries: [
        native('user:native', 'same-turn', 'same-question', 'native')
    ]});
    const target = runtime.store('conversation:promoted');
    const canonical = target.byIdentity.get('user:native');
    runtime.setCurrent('route:/');
    const observed = userTurn('user:dom', 'same-turn', 'same-question', 'observed');
    runtime.observe([observed]);
    runtime.rememberEdit(observed);
    const source = runtime.store('route:/');
    source.identityAliases.set('user:older', 'user:dom');
    source.pairedAssistantToUser.set('assistant:paired', 'user:dom');

    runtime.transfer('route:/', 'conversation:promoted');
    assert.equal(target.index.getEntries()[0], canonical);
    assert.equal(target.turns[0], canonical);
    assert.equal(target.byIdentity.get('user:native'), canonical);
    assert.equal(runtime.resolve(target, 'user:dom'), 'user:native');
    assert.equal(runtime.resolve(target, 'user:older'), 'user:native');
    assert.equal(target.pairedAssistantToUser.get('assistant:paired'), 'user:native');
    assert.equal(runtime.candidate('user:native').identity, 'user:native');
    assert.equal(runtime.candidate('user:native').chatIdentity, 'conversation:promoted');
    assert.equal(canonical.userText, 'observed');
});

test('native snapshots distinguish body changes from branch and positioning changes', () => {
    const {runtime} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const snapshot = {chatId: 'chat', branchKey: 'branch', entries: [
        native('user:A', 'A', 'question-A', 'A'),
        completedAssistant(
            native('user:B', 'B', 'question-B', 'B', ['answer-B']),
            'answer-B',
            'Complete answer B'
        )
    ]};
    assert.equal(runtime.snapshotChanges(snapshot).structureChanged, true);
    const store = runtime.store('conversation:chat');
    const record = store.byIdentity.get('user:B');

    const unchanged = runtime.snapshotChanges({...snapshot, pagination: {complete: true}});
    assert.equal(unchanged.structureChanged, false);
    assert.deepEqual(Array.from(unchanged.changedIdentities), []);

    const provenanceOnly = runtime.snapshotChanges({...snapshot, entries: [
        snapshot.entries[0],
        {
            ...snapshot.entries[1],
            assistantTextSourceMessageIds: ['answer-B', 'answer-B-alias'],
            assistantTextUnresolvedReferenceMessageIds: ['answer-B-pending']
        }
    ]});
    assert.equal(provenanceOnly.structureChanged, false);
    assert.deepEqual(Array.from(provenanceOnly.changedIdentities), []);

    const updated = {...snapshot, entries: [snapshot.entries[0],
        {...snapshot.entries[1], assistantText: 'Updated complete answer B'}]};
    const textChange = runtime.snapshotChanges(updated);
    assert.equal(textChange.structureChanged, false);
    assert.deepEqual(Array.from(textChange.changedIdentities), ['user:B']);
    assert.equal(store.byIdentity.get('user:B'), record);
    assert.equal(record.assistantText, 'Updated complete answer B');

    const metadata = {...updated, entries: [updated.entries[0],
        {...updated.entries[1], assistantMessageIds: ['new-answer']}]};
    assert.equal(runtime.snapshotChanges(metadata).structureChanged, true);
    const extraMetadata = {...metadata, entries: [metadata.entries[0],
        {...metadata.entries[1], extraPositioningData: 'changed'}]};
    assert.equal(runtime.snapshotChanges(extraMetadata).structureChanged, true);
    assert.equal(runtime.snapshotChanges({...extraMetadata, branchKey: 'new-branch'}).structureChanged, true);
});

test('same-message unresolved snapshots and transient DOM text keep a complete native body', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const messageId = 'answer-dil-42';
    const completeBody = 'Complete unmounted response.\nTask paused';
    const initial = {
        chatId: 'chat', branchKey: 'branch', entries: [
            completedAssistant(
                native('user:round-1', 'round-1', 'question-1', 'Question', [messageId]),
                messageId,
                completeBody
            )
        ]
    };
    assert.equal(runtime.snapshot(initial), true);
    const store = runtime.store('conversation:chat');
    const record = store.byIdentity.get('user:round-1');
    const entries = store.index.getEntries();

    const unresolved = {
        ...initial,
        entries: [{
            ...native('user:round-1', 'round-1', 'question-1', 'Question', [messageId]),
            assistantText: `::chatgpt-content-reference{index="4" source_message_id="${messageId}"}`,
            assistantTextUnresolvedReferenceMessageIds: [messageId]
        }]
    };
    assert.equal(runtime.snapshot(unresolved), true);
    assert.equal(record.assistantText, completeBody);
    assert.equal(record.assistantTextSource, 'native-complete');

    const observed = userTurn(
        'user:round-1', 'round-1', 'question-1', 'Question', messageId, 'Task paused'
    );
    runtime.observe([observed]);
    assert.equal(record.assistantText, completeBody);
    const renderedStatus = observed.pairedAssistantUnits[0].children[0];
    renderedStatus.innerText = renderedStatus.textContent = '';
    observed.pairedAssistantUnits[0].innerText =
        observed.pairedAssistantUnits[0].textContent = '';
    assert.equal(runtime.refresh(observed), record);
    assert.equal(record.assistantText, completeBody);
    assert.equal(record.assistantTextSource, 'native-complete');
    assert.equal(store.index.getEntries(), entries);
    assert.equal(store.index.getEntries()[0], record);
});

test('native-complete display sanitizes DIL controls and caps text without changing stored content', () => {
    const {runtime} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const messageId = 'answer-dil-display-42';
    const imageGroup = 'image_group{"query":["materials graph neural networks"],"aspect_ratio":"16:9","layout":"carousel","num_per_query":1}';
    const cite = 'citeturn576258search1';
    const url = 'urlNature Communications 原始论文及补充信息https://doi.org/10.1038/s41467-026-79505-6';
    const readableBody = 'The complete answer explains materials graph neural networks.';
    const pauseSuffix = 'Task paused. Let me know if you need a shorter summary.';
    const rawBody = [
        readableBody,
        imageGroup,
        cite,
        url,
        pauseSuffix,
        'Additional readable discussion of the results. '.repeat(100)
    ].join('\n');
    const snapshot = {
        chatId: 'chat', branchKey: 'branch', entries: [
            completedAssistant(
                native('user:round-1', 'round-1', 'question-1', 'Question', [messageId]),
                messageId,
                rawBody
            )
        ]
    };
    assert.equal(runtime.snapshot(snapshot), true);
    const record = runtime.store('conversation:chat').byIdentity.get('user:round-1');
    const preview = runtime.previewText(record);

    assert.ok(rawBody.length > 4400);
    assert.ok(preview.length <= 2201);
    assert.ok(preview.includes(readableBody));
    assert.ok(preview.includes('Nature Communications 原始论文及补充信息'));
    assert.ok(preview.includes(pauseSuffix));
    assert.equal(preview.includes('image_group'), false);
    assert.equal(preview.includes('materials graph neural networks"'), false);
    assert.equal(preview.includes('turn576258search1'), false);
    assert.equal(preview.includes('https://doi.org/'), false);
    assert.equal(record.assistantText, rawBody);
});

test('a DOM replacement with a new assistant ID updates the target and drops the old ID', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:chat');
    const oldMessageId = 'answer-old-id';
    const newMessageId = 'answer-new-id';
    const completeBody = 'Complete original response.';
    runtime.snapshot({
        chatId: 'chat', branchKey: 'branch', entries: [
            completedAssistant(
                native('user:round-1', 'round-1', 'question-1', 'Question', [oldMessageId]),
                oldMessageId,
                completeBody
            )
        ]
    });
    const store = runtime.store('conversation:chat');
    const record = store.byIdentity.get('user:round-1');

    runtime.observe([userTurn(
        'user:round-1', 'round-1', 'question-1', 'Question',
        newMessageId, 'New streamed response.'
    )]);

    assert.equal(record.assistantText, 'New streamed response.');
    assert.notEqual(record.assistantTextSource, 'native-complete');
    assert.deepEqual(Array.from(record.assistantMessageIds), [newMessageId]);
    assert.equal(record.assistantMessageIds.includes(oldMessageId), false);
    assert.equal(runtime.targetMessageId(record.identity), newMessageId);
});

test('a newer assistant message or plain native content can replace a complete body', () => {
    for (const update of [
        {
            messageId: 'answer-new-id',
            assistantText: 'Complete response for the new assistant ID.',
            assistantTextSource: 'native-complete',
            assistantTextSourceMessageIds: ['answer-new-id'],
            assistantTextUnresolvedReferenceMessageIds: []
        },
        {
            messageId: 'answer-original-id',
            assistantText: 'Plain native assistant content.',
            assistantTextSource: 'native-plain',
            assistantTextSourceMessageIds: [],
            assistantTextUnresolvedReferenceMessageIds: []
        }
    ]) {
        const {runtime} = loadStoreRuntime();
        runtime.setCurrent('conversation:chat');
        const originalId = 'answer-original-id';
        const original = {
            chatId: 'chat', branchKey: 'branch', entries: [
                completedAssistant(
                    native('user:round-1', 'round-1', 'question-1', 'Question', [originalId]),
                    originalId,
                    'Original complete response.'
                )
            ]
        };
        runtime.snapshot(original);
        const nextEntry = {
            ...native('user:round-1', 'round-1', 'question-1', 'Question', [update.messageId]),
            assistantText: update.assistantText,
            assistantTextSource: update.assistantTextSource,
            assistantTextSourceMessageIds: update.assistantTextSourceMessageIds,
            assistantTextUnresolvedReferenceMessageIds:
                update.assistantTextUnresolvedReferenceMessageIds
        };

        assert.equal(runtime.snapshot({...original, entries: [nextEntry]}), true);
        const record = runtime.store('conversation:chat').byIdentity.get('user:round-1');
        assert.equal(record.assistantText, update.assistantText);
        assert.equal(record.assistantTextSource, update.assistantTextSource);
        assert.deepEqual(
            Array.from(record.assistantTextSourceMessageIds),
            update.assistantTextSourceMessageIds
        );
        assert.deepEqual(Array.from(record.assistantMessageIds), [update.messageId]);
    }
});

test('promotion carries an edited branch suppression into an existing native store', () => {
    const {runtime, userTurn} = loadStoreRuntime();
    runtime.setCurrent('conversation:promoted');
    const snapshot = {chatId: 'promoted', branchKey: 'branch', entries: [
        native('user:A', 'A', 'question-A', 'A'),
        native('user:B', 'B', 'question-B', 'before'),
        native('user:C', 'C', 'question-C', 'C')
    ]};
    runtime.snapshot(snapshot);
    const target = runtime.store('conversation:promoted');

    runtime.setCurrent('route:/');
    const a = userTurn('user:A', 'A', 'question-A', 'A');
    const b = userTurn('user:B', 'B', 'question-B', 'before');
    const c = userTurn('user:C', 'C', 'question-C', 'C');
    runtime.observe([a, b, c]);
    runtime.rememberEdit(b);
    b.userBubble.innerText = b.userBubble.textContent = 'edited';
    runtime.observe([a, b, c]);
    runtime.transfer('route:/', 'conversation:promoted');

    assert.deepEqual(Array.from(target.index.getEntries(), record => record.identity), ['user:A', 'user:B']);
    assert.equal(target.byIdentity.has('user:C'), false);
    runtime.setCurrent('conversation:promoted');
    assert.equal(runtime.snapshot(snapshot), false);
    assert.equal(target.byIdentity.get('user:B').userText, 'edited');
});
