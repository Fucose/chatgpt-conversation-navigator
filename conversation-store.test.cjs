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
                const item = part.trim();
                if (item === '[data-turn-key]') return Boolean(this.getAttribute('data-turn-key'));
                if (item === '[data-content-search-turn-key]') return Boolean(this.getAttribute('data-content-search-turn-key'));
                if (item === '[data-user-message-bubble="true"]') return this.getAttribute('data-user-message-bubble') === 'true';
                if (item === '[data-chatgpt-selection-message-id]') return Boolean(this.getAttribute('data-chatgpt-selection-message-id'));
                if (item === '[data-markdown-text-style="assistant-message"]') return this.getAttribute('data-markdown-text-style') === 'assistant-message';
                if (item.includes('data-content-search-unit-key')) return (this.getAttribute('data-content-search-unit-key') || '').endsWith(':assistant');
                if (item.includes('data-chatgpt-search-unit-key')) return (this.getAttribute('data-chatgpt-search-unit-key') || '').includes('assistant');
                return false;
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
            refresh: updateObservedTurnContent,
            rememberEdit(turn) { rememberUserEditCandidate(turn, null); },
            candidate(identity) { return userEditCandidates.get(identity); },
            resolve: resolveRememberedIdentity,
            transfer: transferChatTurnIdentities
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

    return {runtime: context.storeTest, userTurn};
}

function native(identity, turnKey, userId, userText, assistantIds = []) {
    return {identity, turnKey, kind: 'user', userMessageId: userId,
        messageId: userId, assistantMessageIds: assistantIds, userText};
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
        native('user:B', 'B', 'question-B', 'B', ['answer-B'])
    ]};
    assert.equal(runtime.snapshotChanges(snapshot).structureChanged, true);
    const store = runtime.store('conversation:chat');
    const record = store.byIdentity.get('user:B');

    const unchanged = runtime.snapshotChanges({...snapshot, pagination: {complete: true}});
    assert.equal(unchanged.structureChanged, false);
    assert.deepEqual(Array.from(unchanged.changedIdentities), []);
    const updated = {...snapshot, entries: [snapshot.entries[0],
        {...snapshot.entries[1], userText: 'B updated'}]};
    const textChange = runtime.snapshotChanges(updated);
    assert.equal(textChange.structureChanged, false);
    assert.deepEqual(Array.from(textChange.changedIdentities), ['user:B']);
    assert.equal(store.byIdentity.get('user:B'), record);
    assert.equal(record.userText, 'B updated');

    const metadata = {...updated, entries: [updated.entries[0],
        {...updated.entries[1], assistantMessageIds: ['new-answer']}]};
    assert.equal(runtime.snapshotChanges(metadata).structureChanged, true);
    const extraMetadata = {...metadata, entries: [metadata.entries[0],
        {...metadata.entries[1], extraPositioningData: 'changed'}]};
    assert.equal(runtime.snapshotChanges(extraMetadata).structureChanged, true);
    assert.equal(runtime.snapshotChanges({...extraMetadata, branchKey: 'new-branch'}).structureChanged, true);
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
