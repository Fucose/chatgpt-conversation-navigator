// ==UserScript==
// @name         ChatGPT Conversation Navigator
// @namespace    https://github.com/Fucose
// @version      0.5.4
// @description  ChatGPT 对话导航：悬停预览、加载完整历史、回复大纲与章节跳转。
// @author       Fucose
// @homepageURL  https://gist.github.com/Fucose/fc9f1963666d75e7f93a5edceae137c7
// @supportURL   https://gist.github.com/Fucose/fc9f1963666d75e7f93a5edceae137c7#comments
// @updateURL    https://gist.githubusercontent.com/Fucose/fc9f1963666d75e7f93a5edceae137c7/raw/chatgpt-conversation-navigator.user.js
// @downloadURL  https://gist.githubusercontent.com/Fucose/fc9f1963666d75e7f93a5edceae137c7/raw/chatgpt-conversation-navigator.user.js
// @match        https://chatgpt.com/*
// @grant        none
// @sandbox      raw
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    function getNativeCompleteAssistantMessageIds(record) {
        return record?.assistantTextSource === 'native-complete' &&
            Array.isArray(record.assistantTextSourceMessageIds)
                ? record.assistantTextSourceMessageIds.filter(id => typeof id === 'string' && id)
                : [];
    }

    function sharesMessageId(left, right) {
        if (!Array.isArray(left) || !Array.isArray(right) || !left.length || !right.length) {
            return false;
        }
        const rightIds = new Set(right);
        return left.some(id => rightIds.has(id));
    }

    function clearAssistantTextSource(record, source = 'dom') {
        record.assistantTextSource = source;
        record.assistantTextSourceMessageIds = [];
        record.assistantTextUnresolvedReferenceMessageIds = [];
    }

    function copyAssistantTextSource(target, source, fallback = 'dom') {
        target.assistantTextSource = typeof source?.assistantTextSource === 'string'
            ? source.assistantTextSource
            : fallback;
        target.assistantTextSourceMessageIds = Array.isArray(source?.assistantTextSourceMessageIds)
            ? [...source.assistantTextSourceMessageIds]
            : [];
        target.assistantTextUnresolvedReferenceMessageIds = Array.isArray(source?.assistantTextUnresolvedReferenceMessageIds)
            ? [...source.assistantTextUnresolvedReferenceMessageIds]
            : [];
    }

    function createConversationIndex() {
        const entries = [];
        let aliases = new Map();
        let aliasMembers = new Map();
        const entryPositions = new Map();
        const entryAliases = new Map();
        let authoritative = false;
        let branchKey = null;
        const suppressed = new Map();

        function getAliases(entry) {
            const result = new Set();
            if (entry?.identity) result.add(`identity:${entry.identity}`);
            if (entry?.turnKey && entry?.kind) {
                result.add(`turn:${entry.kind}:${entry.turnKey}`);
            }
            for (const messageId of collectMessageEvidenceIds(entry)) {
                result.add(`message:${messageId}`);
            }
            return result;
        }

        function rebuildAliases() {
            aliases = new Map();
            aliasMembers = new Map();
            entryPositions.clear();
            entryAliases.clear();
            for (let index = 0; index < entries.length; index += 1) {
                const entry = entries[index];
                if (!entryPositions.has(entry)) {
                    entryPositions.set(entry, index);
                }
                const keys = getAliases(entry);
                entryAliases.set(entry, keys);
                for (const alias of keys) {
                    let members = aliasMembers.get(alias);
                    if (!members) {
                        members = new Set();
                        aliasMembers.set(alias, members);
                    }
                    members.add(entry);
                    if (!aliases.has(alias)) aliases.set(alias, entry);
                }
            }
        }

        function findFirstAliasMember(alias, kind = null) {
            let first = null;
            let firstPosition = Infinity;
            for (const entry of aliasMembers.get(alias) || []) {
                if (kind && entry.kind !== kind) continue;
                const position = entryPositions.get(entry);
                if (position !== undefined && position < firstPosition) {
                    first = entry;
                    firstPosition = position;
                }
            }
            return first;
        }

        function addAliasMember(alias, entry) {
            let members = aliasMembers.get(alias);
            if (!members) {
                members = new Set();
                aliasMembers.set(alias, members);
            }
            members.add(entry);
            const current = aliases.get(alias);
            if (
                !current ||
                entryPositions.get(entry) < entryPositions.get(current)
            ) {
                aliases.set(alias, entry);
            }
        }

        function removeAliasMember(alias, entry) {
            const members = aliasMembers.get(alias);
            if (!members) return;
            members.delete(entry);
            if (members.size === 0) {
                aliasMembers.delete(alias);
                aliases.delete(alias);
            } else if (aliases.get(alias) === entry) {
                aliases.set(alias, findFirstAliasMember(alias));
            }
        }

        function replaceEntryAt(index, nextEntry) {
            const previous = entries[index];
            // Records are shared with the store. Save aliases separately so even
            // fields changed by a DOM observation can be reindexed correctly.
            const previousAliases = entryAliases.get(previous) || new Set();
            if (previous !== nextEntry) Object.assign(previous, nextEntry);
            const nextAliases = getAliases(previous);
            entryAliases.set(previous, nextAliases);

            for (const alias of previousAliases) {
                if (!nextAliases.has(alias)) {
                    removeAliasMember(alias, previous);
                }
            }
            for (const alias of nextAliases) {
                if (!previousAliases.has(alias)) {
                    addAliasMember(alias, previous);
                }
            }
        }

        function appendEntry(entry) {
            const index = entries.length;
            entries.push(entry);
            entryPositions.set(entry, index);
            const keys = getAliases(entry);
            entryAliases.set(entry, keys);
            for (const alias of keys) {
                addAliasMember(alias, entry);
            }
        }

        function findMatch(incoming) {
            for (const alias of getAliases(incoming)) {
                const match = aliases.get(alias);
                if (match && (!incoming?.kind || match.kind === incoming.kind)) {
                    return match;
                }
                const sameKind = incoming?.kind &&
                    findFirstAliasMember(alias, incoming.kind);
                if (sameKind) return sameKind;
            }
            return null;
        }

        function mergeEntry(previous, incoming, source) {
            const merged = { ...previous };
            const preserveUserText = Boolean(previous?.preserveCommittedUserText);
            const completeAssistantMessageIds = getNativeCompleteAssistantMessageIds(previous);
            const incomingAssistantMessageIds = Array.isArray(incoming?.assistantMessageIds)
                ? incoming.assistantMessageIds
                : [];
            const sameAssistantMessage = sharesMessageId(
                completeAssistantMessageIds,
                incomingAssistantMessageIds
            );
            const unresolvedCompletedMessage = sharesMessageId(
                completeAssistantMessageIds,
                incoming?.assistantTextUnresolvedReferenceMessageIds
            );
            const replaceCompletedAssistant = completeAssistantMessageIds.length > 0 &&
                ['observed', 'snapshot'].includes(source) &&
                incomingAssistantMessageIds.length > 0 &&
                !sameAssistantMessage;
            const preserveCompletedAssistant = completeAssistantMessageIds.length > 0 && (
                source === 'observed' && !replaceCompletedAssistant ||
                source === 'snapshot' && (
                    unresolvedCompletedMessage ||
                    incoming?.assistantText === '' && !replaceCompletedAssistant
                )
            );

            for (const [key, value] of Object.entries(incoming || {})) {
                if (value === undefined || value === null) continue;
                if (
                    source === 'snapshot' &&
                    (key === 'userTextSnapshot' ||
                        key === 'domUserTextBaseline')
                ) {
                    continue;
                }
                if (key === 'userText' && preserveUserText && source === 'snapshot') {
                    continue;
                }
                if (
                    preserveCompletedAssistant &&
                    [
                        'assistantText',
                        'assistantTextSource',
                        'assistantTextSourceMessageIds',
                        'assistantTextUnresolvedReferenceMessageIds'
                    ].includes(key)
                ) {
                    continue;
                }
                if (key === 'assistantMessageIds') {
                    const previousIds = source === 'snapshot'
                        ? []
                        : merged.assistantMessageIds;
                    merged.assistantMessageIds = uniqueMessageIds(previousIds, value);
                    continue;
                }
                if (value !== '') merged[key] = value;
                else if (!(key in merged)) merged[key] = value;
            }

            if (replaceCompletedAssistant) {
                if (incoming?.assistantText === '') merged.assistantText = '';
                copyAssistantTextSource(
                    merged,
                    incoming,
                    source === 'observed' ? 'dom' : 'native-plain'
                );
            }

            if (previous?.identity &&
                (source !== 'snapshot' || !incoming?.identity)) {
                merged.identity = previous.identity;
            }
            // Snapshot reads have no ordering guarantee: even a confirmed edit
            // may be followed by an older snapshot from the same branch.
            if (preserveUserText) merged.preserveCommittedUserText = true;
            return merged;
        }

        function replaceEntries(nextEntries) {
            entries.splice(0, entries.length, ...nextEntries);
            rebuildAliases();
        }

        function resolveEntry(record, options = {}) {
            if (!record?.identity) return null;
            if (options.kind) {
                for (const alias of getAliases(record)) {
                    const match = aliases.get(alias);
                    if (match && match.kind === options.kind) return match;
                    const sameKind = findFirstAliasMember(alias, options.kind);
                    if (sameKind) return sameKind;
                }
                return null;
            }
            return findMatch(record);
        }

        function retire(identity) {
            const index = entries.findIndex(entry =>
                entry.identity === identity
            );
            if (index < 0) return false;
            entries.splice(index, 1);
            rebuildAliases();
            return true;
        }

        function addSuppression(entry) {
            if (!entry?.identity) return;
            suppressed.set(entry.identity, getAliases(entry));
        }

        function isSuppressed(entry) {
            const incomingAliases = getAliases(entry);
            for (const [identity, retiredAliases] of suppressed) {
                if (identity === entry?.identity) return true;
                for (const alias of incomingAliases) {
                    if (retiredAliases.has(alias)) return true;
                }
            }
            return false;
        }

        function upsertObserved(records) {
            const incoming = Array.isArray(records) ? records : [records];
            const orderedObserved = [];
            const orderedObservedPositions = new Map();
            let observedRecordCount = 0;

            for (const item of incoming) {
                if (!item?.identity) continue;
                let match = findMatch(item);
                if (match) {
                    const merged = mergeEntry(match, item, 'observed');
                    const index = entryPositions.get(match);
                    replaceEntryAt(index, merged);
                    const observedPosition = orderedObservedPositions.get(match);
                    if (observedPosition === undefined) {
                        orderedObservedPositions.set(
                            match,
                            orderedObserved.length
                        );
                        orderedObserved.push(match);
                    }
                    observedRecordCount += 1;
                    continue;
                }
                if (authoritative && isSuppressed(item)) continue;

                // An observed record becomes the owned record; no second body copy.
                const created = item;
                appendEntry(created);
                orderedObservedPositions.set(created, orderedObserved.length);
                orderedObserved.push(created);
                observedRecordCount += 1;
            }

            if (!authoritative && observedRecordCount > 1) {
                const observedSet = new Set(orderedObserved);
                const unobserved = entries.filter(entry => !observedSet.has(entry));
                replaceEntries([...orderedObserved, ...unobserved]);
            }

            return entries;
        }

        function applySnapshot(snapshot) {
            const next = Array.isArray(snapshot?.entries)
                ? snapshot.entries
                : [];
            const nextBranchKey = snapshot?.branchKey ?? null;
            const branchChanged = branchKey !== null &&
                nextBranchKey !== null && nextBranchKey !== branchKey;
            // Resolve the entire snapshot against the old alias state. Each old
            // record can be claimed only once, even if snapshot aliases overlap.
            const previousMembers = new Map(Array.from(aliasMembers, ([alias, members]) =>
                [alias, Array.from(members).sort((left, right) =>
                    entryPositions.get(left) - entryPositions.get(right)
                )]
            ));

            const incomingSuppressed = !branchChanged && next.some(isSuppressed);
            if (incomingSuppressed) {
                return { accepted: false, entries };
            }

            const accepted = [];
            const claimed = new Set();
            const identityChanges = [];
            for (const item of next) {
                if (!item?.identity) continue;
                if (!branchChanged && isSuppressed(item)) continue;
                let previous = null;
                for (const alias of getAliases(item)) {
                    previous = (previousMembers.get(alias) || []).find(record =>
                        !claimed.has(record) &&
                        (!item.kind || !record.kind || item.kind === record.kind)
                    );
                    if (previous) break;
                }
                const merged = mergeEntry(previous || {}, item, 'snapshot');
                if (previous) {
                    const oldIdentity = previous.identity;
                    Object.assign(previous, merged);
                    claimed.add(previous);
                    if (oldIdentity !== previous.identity) {
                        identityChanges.push({oldIdentity, identity: previous.identity});
                    }
                    accepted.push(previous);
                } else {
                    accepted.push(merged);
                }
            }

            for (const [identity, retiredAliases] of Array.from(suppressed)) {
                const stillPresent = accepted.some(entry => {
                    const incomingAliases = getAliases(entry);
                    return identity === entry.identity ||
                        Array.from(retiredAliases).some(alias =>
                            incomingAliases.has(alias)
                        );
                });
                /*
                 * A new branch releases entries it contains. Entries absent
                 * from that branch remain hidden in case stale DOM is mounted.
                 */
                if (branchChanged ? stillPresent : !stillPresent) {
                    suppressed.delete(identity);
                }
            }
            branchKey = nextBranchKey;
            authoritative = true;
            replaceEntries(accepted);
            return { accepted: true, entries, identityChanges, branchChanged };
        }

        function pruneFrom(identity, options = {}) {
            rebuildAliases();
            const pivot = entries.findIndex(entry =>
                entry.identity === identity ||
                Array.from(getAliases(entry)).some(alias =>
                    alias === `identity:${identity}`
                )
            );
            if (pivot < 0) return [];

            const keepIdentity = Boolean(options.keepIdentity);
            const firstRemoved = keepIdentity ? pivot + 1 : pivot;
            const removed = entries.slice(firstRemoved);
            for (const entry of removed) {
                addSuppression(entry);
            }
            if (options.keepIdentity && options.userText !== undefined) {
                const entry = entries[pivot];
                entry.userText = options.userText;
                entry.userTextSnapshot = options.userTextSnapshot ?? options.userText;
                entry.domUserTextBaseline = options.domUserTextBaseline ??
                    options.userText;
                entry.preserveCommittedUserText = true;
            }
            entries.splice(firstRemoved);
            rebuildAliases();
            return removed;
        }

        return {
            upsertObserved,
            applySnapshot,
            getEntries: () => entries,
            pruneFrom,
            retire,
            resolveEntry,
            hasSnapshot: () => authoritative,
            getBranchKey: () => branchKey,
            isSuppressed: entry => authoritative && isSuppressed(entry),
            getSuppression: () => new Map(Array.from(suppressed, ([identity, keys]) =>
                [identity, new Set(keys)]
            )),
            mergeSuppression: other => {
                for (const [identity, keys] of other) {
                    if (!suppressed.has(identity)) suppressed.set(identity, new Set(keys));
                }
                const retained = entries.filter(entry => !isSuppressed(entry));
                if (retained.length !== entries.length) replaceEntries(retained);
            },
            rebuildAliases
        };
    }

    function createHistoryLoader(options = {}) {
        const {
            readSnapshot,
            loadPreviousPage,
            getChatIdentity = () => null,
            onSnapshot = () => {},
            getAnchor = () => null,
            compensateAnchor = () => {}
        } = options;
        let runId = 0;
        let stopRequested = false;
        let runningPromise = null;
        const state = {
            status: 'idle',
            running: false,
            complete: false,
            cursor: null,
            hasError: false,
            error: null,
            pagesLoaded: 0
        };

        function snapshotSignature(snapshot) {
            const ids = (snapshot?.entries || []).map(entry => entry.identity);
            return `${snapshot?.pagination?.cursor || ''}|${ids.join('|')}`;
        }

        function updateFromSnapshot(snapshot) {
            const pagination = snapshot?.pagination || {};
            state.cursor = pagination.cursor ?? null;
            state.complete = Boolean(pagination.complete);
            state.hasError = Boolean(pagination.hasError);
            state.error = state.hasError
                ? (pagination.error || new Error('History pagination failed'))
                : null;
        }

        function isCurrent(id, chatIdentity) {
            return id === runId && getChatIdentity() === chatIdentity;
        }

        async function run() {
            if (runningPromise) return runningPromise;
            if (typeof readSnapshot !== 'function' ||
                typeof loadPreviousPage !== 'function') {
                state.status = 'error';
                state.hasError = true;
                state.error = new Error('History loader is not configured');
                return getState();
            }

            const id = ++runId;
            const chatIdentity = getChatIdentity();
            stopRequested = false;
            state.status = 'loading';
            state.running = true;
            state.hasError = false;
            state.error = null;

            const operation = Promise.resolve().then(async () => {
                try {
                    let snapshot = await readSnapshot();
                    if (!isCurrent(id, chatIdentity)) {
                        state.status = 'stale';
                        return getState();
                    }
                    updateFromSnapshot(snapshot);
                    onSnapshot(snapshot, { source: 'refresh', chatIdentity });

                    let signature = snapshotSignature(snapshot);
                    const seenSignatures = new Set([signature]);
                    const seenCursors = new Set([state.cursor]);
                    while (
                        !state.complete &&
                        !stopRequested &&
                        (!state.hasError ||
                            snapshot?.pagination?.canLoadPrevious === true)
                    ) {
                        const anchor = await getAnchor();
                        if (!isCurrent(id, chatIdentity)) break;

                        const pageSnapshot = await loadPreviousPage();
                        if (!isCurrent(id, chatIdentity)) break;
                        snapshot = pageSnapshot && Array.isArray(pageSnapshot.entries)
                            ? pageSnapshot
                            : await readSnapshot();
                        if (!isCurrent(id, chatIdentity)) break;

                        updateFromSnapshot(snapshot);
                        onSnapshot(snapshot, {
                            source: 'page',
                            chatIdentity,
                            pagesLoaded: state.pagesLoaded + 1
                        });
                        await compensateAnchor(anchor, snapshot);
                        state.pagesLoaded += 1;

                        const nextSignature = snapshotSignature(snapshot);
                        const nextCursor = snapshot?.pagination?.cursor ?? null;
                        const progressed = nextSignature !== signature;
                        signature = nextSignature;

                        if (state.hasError) break;
                        if (state.complete) break;
                        const repeatedSignature = seenSignatures.has(nextSignature);
                        const repeatedCursor = nextCursor !== null &&
                            seenCursors.has(nextCursor);
                        seenSignatures.add(nextSignature);
                        if (nextCursor !== null) seenCursors.add(nextCursor);
                        if (!progressed || repeatedSignature || repeatedCursor) {
                            state.status = 'stopped';
                            break;
                        }
                        if (stopRequested) break;
                    }

                    if (!isCurrent(id, chatIdentity)) {
                        state.status = 'stale';
                    } else if (state.hasError) {
                        state.status = 'error';
                    } else if (state.complete) {
                        state.status = 'complete';
                    } else if (stopRequested && state.status !== 'stopped') {
                        state.status = 'stopped';
                    } else if (state.status === 'loading') {
                        state.status = 'stopped';
                    }
                    return getState();
                } catch (error) {
                    if (isCurrent(id, chatIdentity)) {
                        state.status = 'error';
                        state.hasError = true;
                        state.error = error;
                    } else {
                        state.status = 'stale';
                    }
                    return getState();
                } finally {
                    if (id === runId) {
                        state.running = false;
                        runningPromise = null;
                    }
                }
            });
            runningPromise = operation.then(() => getState());

            return runningPromise;
        }

        function getState() {
            return { ...state };
        }

        return {
            start: () => run(),
            stop: () => {
                if (!state.running) return false;
                stopRequested = true;
                return true;
            },
            getState
        };
    }

    async function runBoundedScrollSearch({
        estimateTop,
        stepSize,
        initialDirection = 1,
        maxSteps = 24,
        timeoutMs = 8000,
        maxNoProgress = 2,
        getTop,
        setTop,
        findTarget,
        isCurrent = () => true,
        waitForStep = () => new Promise(resolve => setTimeout(resolve, 120))
    } = {}) {
        const startedAt = Date.now();
        const direction = initialDirection < 0 ? -1 : 1;
        const originalTop = getTop();
        const safeStepSize = Math.max(1, Number(stepSize) || 1);
        const safeMaxSteps = Math.max(0, Math.floor(maxSteps));
        const stepsPerDirection = Math.ceil(safeMaxSteps / 2);
        let steps = 0;

        async function inspectAt(top) {
            if (!isCurrent()) return {cancelled: true};
            const before = getTop();
            setTop(top);
            steps += 1;
            await waitForStep();
            if (!isCurrent()) return {cancelled: true};
            const target = findTarget();
            return target
                ? {target}
                : {noProgress: Math.abs(getTop() - before) < 1};
        }

        const initial = await inspectAt(estimateTop);
        if (initial.cancelled) {
            return {target: null, reason: 'CANCELLED', steps, originalTop};
        }
        if (initial.target) {
            return {target: initial.target, reason: 'FOUND', steps, originalTop};
        }

        for (const scanDirection of [direction, -direction]) {
            let noProgress = 0;
            for (let offset = 1; offset <= stepsPerDirection && steps < safeMaxSteps; offset += 1) {
                if (Date.now() - startedAt >= timeoutMs) {
                    return {target: null, reason: 'TIMEOUT', steps, originalTop};
                }
                const result = await inspectAt(
                    estimateTop + scanDirection * safeStepSize * offset
                );
                if (result.cancelled) {
                    return {target: null, reason: 'CANCELLED', steps, originalTop};
                }
                if (result.target) {
                    return {target: result.target, reason: 'FOUND', steps, originalTop};
                }
                noProgress = result.noProgress ? noProgress + 1 : 0;
                if (noProgress >= maxNoProgress) break;
            }
        }

        return {
            target: null,
            reason: Date.now() - startedAt >= timeoutMs ? 'TIMEOUT' : 'NOT_FOUND',
            steps,
            originalTop
        };
    }

    const { createNativeAdapter, createNativeLocator, NativeAdapterError } = (() => {
        const NATIVE_DISCOVERY_CACHE = new WeakMap();
        const NATIVE_DISCOVERY_MAX_FACTORIES = 20_000;
        const NATIVE_DISCOVERY_MAX_SOURCE_BYTES = 100_000_000;

        const MODULE_PRELOAD_SELECTOR = 'link[rel="modulepreload"][href]';
        const REACT_FIBER_PROPERTY_PREFIXES = [
            '__reactFiber$',
            '__reactInternalInstance$',
        ];
        const MAX_PAGE_ELEMENTS = 200_000;
        const MAX_FIBER_NODES_PER_ROOT = 200_000;
        const MAX_RUNTIME_CANDIDATES = 32;
        const PAGE_LOAD_WAIT_MS = 60_000;
        const PAGE_LOAD_POLL_MS = 250;

        class NativeAdapterError extends Error {
            constructor(code, message) {
                super(message);
                this.name = 'NativeAdapterError';
                this.code = code;
            }
        }

        function fail(code, message) {
            throw new NativeAdapterError(code, message);
        }

        function tokenizeFactorySource(source) {
            const tokens = [];
            const pairs = new Map();
            const stack = [];
            let index = 0;

            while (index < source.length) {
                const character = source[index];
                if (/\s/.test(character)) {
                    index += 1;
                    continue;
                }
                if (character === '/' && source[index + 1] === '/') {
                    index += 2;
                    while (index < source.length && source[index] !== '\n') index += 1;
                    continue;
                }
                if (character === '/' && source[index + 1] === '*') {
                    const close = source.indexOf('*/', index + 2);
                    index = close < 0 ? source.length : close + 2;
                    continue;
                }

                if (character === '"' || character === "'") {
                    const quote = character;
                    const start = index++;
                    let raw = '';
                    while (index < source.length) {
                        const current = source[index++];
                        if (current === '\\') {
                            if (index < source.length) raw += current + source[index++];
                            continue;
                        }
                        if (current === quote) break;
                        raw += current;
                    }
                    const value = raw
                        .replace(/\\n/g, '\n')
                        .replace(/\\r/g, '\r')
                        .replace(/\\t/g, '\t')
                        .replace(/\\(['"\\])/g, '$1');
                    tokens.push({type: 'string', value, start, end: index});
                    continue;
                }

                if (character.charCodeAt(0) === 96) {
                    const start = index++;
                    while (index < source.length) {
                        if (source[index] === '\\') {
                            index += 2;
                            continue;
                        }
                        if (source.charCodeAt(index++) === 96) break;
                    }
                    tokens.push({type: 'template', value: null, start, end: index});
                    continue;
                }

                if (/[A-Za-z_$]/.test(character)) {
                    const start = index++;
                    while (index < source.length && /[A-Za-z0-9_$]/.test(source[index])) index += 1;
                    tokens.push({type: 'identifier', value: source.slice(start, index), start, end: index});
                    continue;
                }
                if (/[0-9]/.test(character)) {
                    const start = index++;
                    while (index < source.length && /[A-Za-z0-9_.]/.test(source[index])) index += 1;
                    tokens.push({type: 'number', value: source.slice(start, index), start, end: index});
                    continue;
                }

                const start = index;
                const operator = ['===', '!==', '...', '=>', '?.', '??', '==', '!=', '<=', '>=', '&&', '||', '++', '--']
                    .find(value => source.startsWith(value, index));
                index += operator ? operator.length : 1;
                tokens.push({type: 'punct', value: operator || character, start, end: index});
            }

            for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
                const value = tokens[tokenIndex].value;
                if (value === '(' || value === '[' || value === '{') {
                    stack.push(tokenIndex);
                } else if (value === ')' || value === ']' || value === '}') {
                    const openIndex = stack.pop();
                    if (openIndex === undefined) continue;
                    const open = tokens[openIndex].value;
                    if (
                        (open === '(' && value === ')') ||
                        (open === '[' && value === ']') ||
                        (open === '{' && value === '}')
                    ) {
                        pairs.set(openIndex, tokenIndex);
                        pairs.set(tokenIndex, openIndex);
                    }
                }
            }

            return {tokens, pairs};
        }

        function splitTokenRange(tokens, pairs, start, end) {
            const ranges = [];
            let rangeStart = start;
            for (let index = start; index < end; index += 1) {
                const paired = pairs.get(index);
                if (paired > index) {
                    index = paired;
                    continue;
                }
                if (tokens[index].value === ',') {
                    ranges.push([rangeStart, index]);
                    rangeStart = index + 1;
                }
            }
            if (rangeStart < end) ranges.push([rangeStart, end]);
            return ranges;
        }

        function readStaticMember(tokens, pairs, start, end = tokens.length) {
            while (
                end - start >= 2 &&
                tokens[start]?.value === '(' &&
                pairs.get(start) === end - 1
            ) {
                start += 1;
                end -= 1;
            }
            const object = tokens[start];
            if (object?.type !== 'identifier') return null;

            if (
                tokens[start + 1]?.value === '.' &&
                tokens[start + 2]?.type === 'identifier' &&
                start + 3 === end
            ) {
                return {object: object.value, property: tokens[start + 2].value};
            }
            if (
                tokens[start + 1]?.value === '[' &&
                tokens[start + 2]?.type === 'string' &&
                pairs.get(start + 1) === start + 3 &&
                start + 4 === end
            ) {
                return {object: object.value, property: tokens[start + 2].value};
            }
            return null;
        }

        function getMemberAt(tokens, index) {
            const object = tokens[index];
            if (object?.type !== 'identifier') return null;
            if (tokens[index + 1]?.value === '.' && tokens[index + 2]?.type === 'identifier') {
                return {object: object.value, property: tokens[index + 2].value, end: index + 3};
            }
            if (
                tokens[index + 1]?.value === '[' &&
                tokens[index + 2]?.type === 'string' &&
                tokens[index + 3]?.value === ']'
            ) {
                return {object: object.value, property: tokens[index + 2].value, end: index + 4};
            }
            return null;
        }

        function getMemberCalls(parsed, start = 0, end = parsed.tokens.length) {
            const {tokens, pairs} = parsed;
            const calls = [];
            for (let index = start; index < end; index += 1) {
                const member = getMemberAt(tokens, index);
                if (!member) continue;

                let openIndex = member.end;
                if (tokens[openIndex]?.value === ')' && tokens[openIndex + 1]?.value === '(') {
                    openIndex += 1;
                }
                if (tokens[openIndex]?.value !== '(' || pairs.get(openIndex) === undefined) continue;
                const closeIndex = pairs.get(openIndex);
                if (closeIndex > end) continue;
                const calleeStart =
                    tokens[index - 3]?.value === '(' &&
                    tokens[index - 2]?.value === '0' &&
                    tokens[index - 1]?.value === ',' &&
                    tokens[member.end]?.value === ')'
                        ? index - 3
                        : index;
                calls.push({
                    object: member.object,
                    property: member.property,
                    start: calleeStart,
                    args: splitTokenRange(tokens, pairs, openIndex + 1, closeIndex),
                });
            }
            return calls;
        }

        function getAssignedIdentifier(tokens, pairs, expressionStart) {
            const assignmentStart = tokens[expressionStart - 1]?.value === 'async'
                ? expressionStart - 1
                : expressionStart;
            const equals = assignmentStart - 1;
            const identifier = tokens[equals - 1];
            if (tokens[equals]?.value !== '=' || identifier?.type !== 'identifier') return null;
            if (!['const', 'let', 'var', ',', ';', '{', '}'].includes(tokens[equals - 2]?.value)) return null;
            return identifier.value;
        }

        function getFunctionParameters(tokens, pairs, openIndex, closeIndex) {
            return splitTokenRange(tokens, pairs, openIndex + 1, closeIndex)
                .map(([start]) => tokens[start]?.type === 'identifier' ? tokens[start].value : null)
                .filter(Boolean);
        }

        function getFactoryParameters(source) {
            const patterns = [
                /^\s*(?:async\s+)?function(?:\s+[$A-Za-z_][$\w]*)?\s*\(([^)]*)\)/,
                /^\s*(?:async\s*)?\(([^)]*)\)\s*=>/,
                /^\s*(?:async\s+)?([$A-Za-z_][$\w]*)\s*=>/,
            ];
            for (const pattern of patterns) {
                const match = source.match(pattern);
                if (!match) continue;
                return (match[1] || '')
                    .split(',')
                    .map(value => value.trim().split('=')[0].trim())
                    .filter(value => /^[A-Za-z_$][\w$]*$/.test(value));
            }
            return [];
        }

        function getFactoryBodyRange(parsed) {
            const {tokens, pairs} = parsed;
            let paramsOpen = -1;
            let paramsClose = -1;
            if (tokens[0]?.value === 'function') {
                paramsOpen = 1;
                while (paramsOpen < tokens.length && tokens[paramsOpen].value !== '(') paramsOpen += 1;
                paramsClose = pairs.get(paramsOpen) ?? -1;
                const bodyOpen = paramsClose + 1;
                if (tokens[bodyOpen]?.value === '{') {
                    return {start: bodyOpen + 1, end: pairs.get(bodyOpen)};
                }
            } else if (tokens[0]?.value === '(') {
                paramsClose = pairs.get(0) ?? -1;
                if (tokens[paramsClose + 1]?.value === '=>') {
                    const bodyOpen = paramsClose + 2;
                    if (tokens[bodyOpen]?.value === '{') {
                        return {start: bodyOpen + 1, end: pairs.get(bodyOpen)};
                    }
                }
            }
            return null;
        }

        function getFactoryFunctions(parsed) {
            const {tokens, pairs} = parsed;
            const functions = new Map();
            const body = getFactoryBodyRange(parsed);
            if (!body || body.end === undefined) return functions;

            function add(name, params, bodyOpen) {
                const bodyClose = pairs.get(bodyOpen);
                if (!name || bodyClose === undefined) return;
                const existing = functions.get(name) || [];
                existing.push({name, params, start: bodyOpen + 1, end: bodyClose});
                functions.set(name, existing);
            }

            for (let index = body.start; index < body.end;) {
                if (tokens[index].value === 'function') {
                    let open = index + 1;
                    const name = tokens[open]?.type === 'identifier'
                        ? tokens[open++].value
                        : getAssignedIdentifier(tokens, pairs, index);
                    while (open < body.end && tokens[open].value !== '(') open += 1;
                    const close = pairs.get(open);
                    const bodyOpen = close === undefined ? -1 : close + 1;
                    if (tokens[bodyOpen]?.value === '{' && pairs.has(bodyOpen)) {
                        add(name, getFunctionParameters(tokens, pairs, open, close), bodyOpen);
                        index = pairs.get(bodyOpen) + 1;
                        continue;
                    }
                }

                if (tokens[index].value === '=>') {
                    let paramsOpen = -1;
                    let paramsClose = -1;
                    if (tokens[index - 1]?.value === ')') {
                        paramsClose = index - 1;
                        paramsOpen = pairs.get(paramsClose) ?? -1;
                    }
                    const params = paramsOpen >= 0
                        ? getFunctionParameters(tokens, pairs, paramsOpen, paramsClose)
                        : tokens[index - 1]?.type === 'identifier'
                            ? [tokens[index - 1].value]
                            : [];
                    const assignmentStart = paramsOpen >= 0 ? paramsOpen : index - 1;
                    const name = getAssignedIdentifier(tokens, pairs, assignmentStart);
                    const bodyOpen = index + 1;
                    if (tokens[bodyOpen]?.value === '{' && pairs.has(bodyOpen)) {
                        add(name, params, bodyOpen);
                        index = pairs.get(bodyOpen) + 1;
                        continue;
                    }
                }

                if (tokens[index].value === '{' && pairs.has(index)) {
                    index = pairs.get(index) + 1;
                    continue;
                }
                index += 1;
            }
            return functions;
        }

        function getStaticModuleId(tokens, range) {
            if (!range || range[1] - range[0] !== 1) return null;
            const token = tokens[range[0]];
            return token?.type === 'string' || token?.type === 'number'
                ? token.value
                : null;
        }

        function getObjectPropertyRanges(parsed, start, end) {
            const {tokens, pairs} = parsed;
            if (tokens[start]?.value !== '{' || pairs.get(start) !== end - 1) return [];
            const properties = [];
            for (const [propertyStart, propertyEnd] of splitTokenRange(tokens, pairs, start + 1, end - 1)) {
                const keyToken = tokens[propertyStart];
                const key = keyToken?.type === 'identifier' || keyToken?.type === 'string'
                    ? keyToken.value
                    : null;
                const colon = propertyStart + 1;
                if (!key || tokens[colon]?.value !== ':') continue;
                properties.push({key, start: colon + 1, end: propertyEnd});
            }
            return properties;
        }

        function getArrowFunctionBody(tokens, pairs, start, end) {
            let arrow = start;
            if (tokens[arrow]?.value === 'async') arrow += 1;
            if (tokens[arrow]?.type === 'identifier' && tokens[arrow + 1]?.value === '=>') {
                arrow += 1;
            } else if (tokens[arrow]?.value === '(' && pairs.get(arrow) !== undefined) {
                arrow = pairs.get(arrow) + 1;
            }
            if (tokens[arrow]?.value !== '=>' || arrow + 1 >= end) return null;
            return {start: arrow + 1, end};
        }

        function getGetterExportMappings(parsed, start, end) {
            const {tokens, pairs} = parsed;
            const mappings = [];
            for (const property of getObjectPropertyRanges(parsed, start, end)) {
                const body = getArrowFunctionBody(tokens, pairs, property.start, property.end);
                if (!body) {
                    if (property.end - property.start === 1 && tokens[property.start]?.type === 'identifier') {
                        mappings.push([property.key, tokens[property.start].value]);
                    }
                    continue;
                }

                let local = null;
                if (body.end - body.start === 1 && tokens[body.start]?.type === 'identifier') {
                    local = tokens[body.start].value;
                } else if (
                    tokens[body.start]?.value === '{' &&
                    pairs.get(body.start) === body.end - 1
                ) {
                    const bodyClose = pairs.get(body.start);
                    for (let index = body.start + 1; index < bodyClose;) {
                        if (tokens[index].value === 'return' && tokens[index + 1]?.type === 'identifier') {
                            const afterReturn = tokens[index + 2]?.value === ';' ? index + 3 : index + 2;
                            if (afterReturn === bodyClose) local = tokens[index + 1].value;
                            break;
                        }
                        const paired = pairs.get(index);
                        index = paired > index ? paired + 1 : index + 1;
                    }
                }
                if (local) mappings.push([property.key, local]);
            }
            return mappings;
        }

        function getInlineFunction(parsed, start, end) {
            const {tokens, pairs} = parsed;
            let index = start;
            if (tokens[index]?.value === 'async') index += 1;
            if (tokens[index]?.value !== 'function') return null;
            index += 1;
            if (tokens[index]?.type === 'identifier') index += 1;
            const paramsOpen = index;
            const paramsClose = pairs.get(paramsOpen);
            if (tokens[paramsOpen]?.value !== '(' || paramsClose === undefined) return null;
            const bodyOpen = paramsClose + 1;
            const bodyClose = pairs.get(bodyOpen);
            if (tokens[bodyOpen]?.value !== '{' || bodyClose !== end - 1) return null;
            return {
                params: getFunctionParameters(tokens, pairs, paramsOpen, paramsClose),
                start: bodyOpen + 1,
                end: bodyClose,
            };
        }

        function getValueExportMappings(parsed, start, end) {
            const {tokens} = parsed;
            const mappings = [];
            for (const property of getObjectPropertyRanges(parsed, start, end)) {
                if (property.end - property.start === 1 && tokens[property.start]?.type === 'identifier') {
                    mappings.push({key: property.key, local: tokens[property.start].value});
                    continue;
                }
                const fn = getInlineFunction(parsed, property.start, property.end);
                if (fn) mappings.push({key: property.key, fn});
            }
            return mappings;
        }

        function parseFactorySource(id, source) {
            const parsed = tokenizeFactorySource(source);
            const {tokens, pairs} = parsed;
            const parameters = getFactoryParameters(source);
            const requireName = parameters[2];
            const exportsName = parameters[1];
            const imports = new Map();
            const exports = new Map();
            const functionExports = new Map();

            function setLocalExport(key, local) {
                functionExports.delete(key);
                exports.set(key, local);
            }

            function setFunctionExport(key, fn) {
                exports.delete(key);
                functionExports.set(key, fn);
            }

            if (requireName) {
                for (let index = 0; index < tokens.length; index += 1) {
                    if (
                        tokens[index].value !== requireName ||
                        tokens[index + 1]?.value !== '(' ||
                        pairs.get(index + 1) === undefined
                    ) continue;
                    const args = splitTokenRange(tokens, pairs, index + 2, pairs.get(index + 1));
                    const moduleId = getStaticModuleId(tokens, args[0]);
                    const alias = tokens[index - 2];
                    if (moduleId !== null && tokens[index - 1]?.value === '=' && alias?.type === 'identifier') {
                        imports.set(alias.value, moduleId);
                    }
                }
            }

            if (exportsName) {
                for (let index = 0; index < tokens.length; index += 1) {
                    if (tokens[index].value !== exportsName) continue;
                    const member = getMemberAt(tokens, index);
                    if (
                        member &&
                        tokens[member.end]?.value === '=' &&
                        tokens[member.end + 1]?.type === 'identifier'
                    ) {
                        setLocalExport(member.property, tokens[member.end + 1].value);
                    }
                }
            }

            if (requireName && exportsName) {
                for (const call of getMemberCalls(parsed)) {
                    if (call.object !== requireName || call.property !== 'd' || call.args.length < 2) continue;
                    const firstArg = call.args[0];
                    if (firstArg[1] - firstArg[0] !== 1 || tokens[firstArg[0]]?.value !== exportsName) continue;
                    const getterRange = call.args[1];
                    if (getterRange) {
                        for (const [key, local] of getGetterExportMappings(parsed, ...getterRange)) {
                            setLocalExport(key, local);
                        }
                    }
                    const valueRange = call.args[2];
                    if (valueRange) {
                        for (const mapping of getValueExportMappings(parsed, ...valueRange)) {
                            if (mapping.fn) setFunctionExport(mapping.key, mapping.fn);
                            else setLocalExport(mapping.key, mapping.local);
                        }
                    }
                }
            }

            return {
                id,
                source,
                parsed,
                imports,
                exports,
                functionExports,
                functions: getFactoryFunctions(parsed),
                anchorsPresent: tokens.some(token => token.type === 'string' && token.value === 'chatgpt-conversation-page') &&
                    tokens.some(token => token.type === 'string' && token.value.includes('/conversations/{conversation_id}/messages')),
            };
        }

        function getFunctionForLocal(factory, local) {
            const functions = factory.functions.get(local) || [];
            return functions.length === 1 ? functions[0] : null;
        }

        function getFactoryExportNames(factory) {
            return new Set([...factory.exports.keys(), ...factory.functionExports.keys()]);
        }

        function getFunctionForExport(factory, exportName) {
            return factory.functionExports.get(exportName) ||
                getFunctionForLocal(factory, factory.exports.get(exportName));
        }

        function getLoaderCandidates(factory) {
            if (!factory.anchorsPresent) return [];
            const candidates = [];
            const {tokens, pairs} = factory.parsed;

            for (const exportName of getFactoryExportNames(factory)) {
                const fn = getFunctionForExport(factory, exportName);
                if (!fn || fn.params.length < 3) continue;
                const hasPageKey = tokens.slice(fn.start, fn.end).some(token =>
                    token.type === 'string' && token.value === 'chatgpt-conversation-page'
                );
                const hasEndpoint = tokens.slice(fn.start, fn.end).some(token =>
                    token.type === 'string' && token.value.includes('/conversations/{conversation_id}/messages')
                );
                if (!hasPageKey || !hasEndpoint) continue;

                for (const call of getMemberCalls(factory.parsed, fn.start, fn.end)) {
                    if (
                        call.object !== fn.params[0] ||
                        call.property !== 'get' ||
                        call.args.length < 2 ||
                        call.args[1][1] - call.args[1][0] !== 1 ||
                        tokens[call.args[1][0]]?.value !== fn.params[1]
                    ) continue;
                    const selector = readStaticMember(tokens, pairs, ...call.args[0]);
                    const paginationId = selector && factory.imports.get(selector.object);
                    if (!selector || paginationId === undefined) continue;
                    candidates.push({
                        loaderId: factory.id,
                        loaderExport: exportName,
                        paginationId,
                        paginationExport: selector.property,
                    });
                }
            }
            return candidates;
        }

        function findHookInitializer(factory, fn, local) {
            const {tokens, pairs} = factory.parsed;
            for (const call of getMemberCalls(factory.parsed, fn.start, fn.end)) {
                if (
                    !factory.imports.has(call.object) ||
                    getAssignedIdentifier(tokens, pairs, call.start) !== local ||
                    !call.args.length
                ) continue;
                const selector = readStaticMember(tokens, pairs, ...call.args[0]);
                const selectorId = selector && factory.imports.get(selector.object);
                if (selector && selectorId !== undefined) {
                    return {moduleId: selectorId, exportName: selector.property};
                }
            }
            return null;
        }

        function usesPaginationSelector(factory, fn, paginationId, paginationExport) {
            const {tokens, pairs} = factory.parsed;
            return getMemberCalls(factory.parsed, fn.start, fn.end).some(call => {
                if (!factory.imports.has(call.object) || !call.args.length) return false;
                const selector = readStaticMember(tokens, pairs, ...call.args[0]);
                return selector?.property === paginationExport &&
                    factory.imports.get(selector.object) === paginationId &&
                    Boolean(getAssignedIdentifier(tokens, pairs, call.start));
            });
        }

        function getInlineArrowCallback(parsed, start, end) {
            const {tokens, pairs} = parsed;
            while (
                end - start >= 2 &&
                tokens[start]?.value === '(' &&
                pairs.get(start) === end - 1
            ) {
                start += 1;
                end -= 1;
            }

            let arrow = start;
            if (tokens[arrow]?.value === 'async') arrow += 1;
            let parameter = null;
            if (tokens[arrow]?.type === 'identifier' && tokens[arrow + 1]?.value === '=>') {
                parameter = tokens[arrow].value;
                arrow += 1;
            } else if (tokens[arrow]?.value === '(' && pairs.get(arrow) !== undefined) {
                const parameterRanges = splitTokenRange(tokens, pairs, arrow + 1, pairs.get(arrow));
                if (
                    parameterRanges.length !== 1 ||
                    parameterRanges[0][1] - parameterRanges[0][0] !== 1 ||
                    tokens[parameterRanges[0][0]]?.type !== 'identifier'
                ) return null;
                parameter = tokens[parameterRanges[0][0]].value;
                arrow = pairs.get(arrow) + 1;
            }
            if (!parameter || tokens[arrow]?.value !== '=>') return null;

            const bodyOpen = arrow + 1;
            const bodyClose = pairs.get(bodyOpen);
            if (tokens[bodyOpen]?.value !== '{' || bodyClose !== end - 1) return null;
            return {parameter, bodyOpen, start: bodyOpen + 1, end: bodyClose};
        }

        function getArrowExpressionEnd(tokens, pairs, start, end) {
            for (let index = start; index < end; index += 1) {
                const paired = pairs.get(index);
                if (paired > index) {
                    index = paired;
                    continue;
                }
                if ([',', ';', ')', ']', '}'].includes(tokens[index]?.value)) return index;
            }
            return end;
        }

        function getNestedFunctionRanges(parsed, start, end) {
            const {tokens, pairs} = parsed;
            const ranges = [];
            for (let index = start; index < end; index += 1) {
                if (tokens[index]?.value === '=>') {
                    const bodyOpen = index + 1;
                    const bodyClose = pairs.get(bodyOpen);
                    const rangeEnd = tokens[bodyOpen]?.value === '{' && bodyClose !== undefined
                        ? bodyClose + 1
                        : getArrowExpressionEnd(tokens, pairs, bodyOpen, end);
                    ranges.push({start: index, end: rangeEnd});
                    index = Math.max(index, rangeEnd - 1);
                    continue;
                }

                if (tokens[index]?.value !== 'function') continue;
                let paramsOpen = index + 1;
                if (tokens[paramsOpen]?.value === '*') paramsOpen += 1;
                if (tokens[paramsOpen]?.type === 'identifier') paramsOpen += 1;
                while (paramsOpen < end && tokens[paramsOpen]?.value !== '(') paramsOpen += 1;
                const paramsClose = pairs.get(paramsOpen);
                const bodyOpen = paramsClose === undefined ? -1 : paramsClose + 1;
                const bodyClose = pairs.get(bodyOpen);
                if (
                    tokens[bodyOpen]?.value !== '{' ||
                    bodyClose === undefined ||
                    bodyClose >= end
                ) continue;
                ranges.push({start: index, end: bodyClose + 1});
                index = bodyClose;
            }
            return ranges;
        }

        function isCallbackBodyTopLevel(parsed, callback, position) {
            const {tokens, pairs} = parsed;
            for (let index = callback.start; index < position; index += 1) {
                if (tokens[index]?.value === '{' && pairs.get(index) > position) return false;
                const paired = pairs.get(index);
                if (paired > index) index = paired;
            }
            return true;
        }

        function declarationShadowsName(parsed, declarationIndex, end, names) {
            const {tokens, pairs} = parsed;
            let bindingStart = declarationIndex + 1;
            while (bindingStart < end) {
                const token = tokens[bindingStart];
                if (token?.type === 'identifier') {
                    if (names.has(token.value)) return true;
                    bindingStart += 1;
                } else if (token?.value === '{' || token?.value === '[') {
                    const close = pairs.get(bindingStart);
                    if (close === undefined || close >= end) return true;
                    for (let index = bindingStart + 1; index < close; index += 1) {
                        if (tokens[index]?.type === 'identifier' && names.has(tokens[index].value)) return true;
                    }
                    bindingStart = close + 1;
                } else {
                    return true;
                }

                while (bindingStart < end) {
                    const paired = pairs.get(bindingStart);
                    if (paired > bindingStart) {
                        bindingStart = paired + 1;
                        continue;
                    }
                    if (tokens[bindingStart]?.value === ',') {
                        bindingStart += 1;
                        break;
                    }
                    if (tokens[bindingStart]?.value === ';' || tokens[bindingStart]?.value === ')') return false;
                    bindingStart += 1;
                }
            }
            return false;
        }

        function hasCallbackShadow(parsed, callback, names, nestedRanges) {
            const {tokens, pairs} = parsed;
            const nestedStarts = new Map(nestedRanges.map(range => [range.start, range.end]));
            for (let index = callback.start; index < callback.end; index += 1) {
                if (nestedStarts.has(index)) {
                    if (
                        tokens[index]?.value === 'function' &&
                        tokens[index + 1]?.type === 'identifier' &&
                        names.has(tokens[index + 1].value)
                    ) return true;
                    index = nestedStarts.get(index) - 1;
                    continue;
                }

                const declaration = tokens[index]?.value;
                if (
                    ['const', 'let', 'var'].includes(declaration) &&
                    (declaration === 'var' || isCallbackBodyTopLevel(parsed, callback, index)) &&
                    declarationShadowsName(parsed, index, callback.end, names)
                ) return true;
                if (
                    ['function', 'class'].includes(declaration) &&
                    isCallbackBodyTopLevel(parsed, callback, index) &&
                    tokens[index + 1]?.type === 'identifier' &&
                    names.has(tokens[index + 1].value)
                ) return true;

                const paired = pairs.get(index);
                if (paired > index && tokens[index]?.value !== '{') index = paired;
            }
            return false;
        }

        function getWrappedImportedMember(factory, range) {
            const {parsed} = factory;
            const callback = getInlineArrowCallback(parsed, ...range);
            if (!callback) return null;

            const nestedRanges = getNestedFunctionRanges(parsed, callback.start, callback.end);
            const shadowedNames = new Set([callback.parameter]);
            if (hasCallbackShadow(parsed, callback, shadowedNames, nestedRanges)) return null;
            const candidates = new Map();
            for (const call of getMemberCalls(parsed, callback.start, callback.end)) {
                if (
                    nestedRanges.some(item => call.start >= item.start && call.start < item.end) ||
                    !isCallbackBodyTopLevel(parsed, callback, call.start)
                ) continue;
                const moduleId = factory.imports.get(call.object);
                if (
                    moduleId === undefined ||
                    call.args.length !== 1 ||
                    readIdentifierRange(parsed, ...call.args[0]) !== callback.parameter ||
                    call.object === callback.parameter
                ) continue;

                if (call.object !== callback.parameter) {
                    const names = new Set([...shadowedNames, call.object]);
                    if (hasCallbackShadow(parsed, callback, names, nestedRanges)) continue;
                }

                const member = {object: call.object, property: call.property, moduleId};
                candidates.set(JSON.stringify([moduleId, call.property]), member);
            }
            return candidates.size === 1 ? candidates.values().next().value : null;
        }

        function readIdentifierRange(parsed, start, end) {
            const {tokens, pairs} = parsed;
            while (
                end - start >= 2 &&
                tokens[start]?.value === '(' &&
                pairs.get(start) === end - 1
            ) {
                start += 1;
                end -= 1;
            }
            return end - start === 1 && tokens[start]?.type === 'identifier'
                ? tokens[start].value
                : null;
        }

        function findComponentGraphs(factories, loader) {
            const graphs = [];
            for (const factory of factories) {
                if (!factory.source.includes(loader.loaderId)) continue;
                for (const historyExport of getFactoryExportNames(factory)) {
                    const fn = getFunctionForExport(factory, historyExport);
                    if (!fn) continue;
                    const {tokens, pairs} = factory.parsed;
                    for (const call of getMemberCalls(factory.parsed, fn.start, fn.end)) {
                        if (
                            factory.imports.get(call.object) !== loader.loaderId ||
                            call.property !== loader.loaderExport ||
                            call.args.length < 3
                        ) continue;

                        const scopeLocal = call.args[0][1] - call.args[0][0] === 1
                            ? tokens[call.args[0][0]]?.value
                            : null;
                        const keyLocal = call.args[1][1] - call.args[1][0] === 1
                            ? tokens[call.args[1][0]]?.value
                            : null;
                        const directFlush = readStaticMember(tokens, pairs, ...call.args[2]);
                        const flush = directFlush
                            ? {
                                ...directFlush,
                                moduleId: factory.imports.get(directFlush.object),
                            }
                            : getWrappedImportedMember(factory, call.args[2]);
                        const scope = scopeLocal && findHookInitializer(factory, fn, scopeLocal);
                        const state = keyLocal && findHookInitializer(factory, fn, keyLocal);
                        const reactDomId = flush?.moduleId;
                        if (
                            !scope ||
                            !state ||
                            !flush ||
                            reactDomId === undefined ||
                            !usesPaginationSelector(factory, fn, loader.paginationId, loader.paginationExport)
                        ) continue;

                        graphs.push({
                            scopeId: scope.moduleId,
                            scopeExport: scope.exportName,
                            stateId: state.moduleId,
                            stateExport: state.exportName,
                            paginationId: loader.paginationId,
                            paginationExport: loader.paginationExport,
                            loaderId: loader.loaderId,
                            loaderExport: loader.loaderExport,
                            reactDomId,
                            reactDomExport: flush.property,
                            historyId: factory.id,
                            historyExport,
                        });
                    }
                }
            }
            return graphs;
        }

        function captureModuleState(requireFunction) {
            const moduleMap = requireFunction.m;
            let ids;
            try {
                ids = Object.keys(moduleMap).sort();
            } catch (_error) {
                fail('NATIVE_MODULE_SOURCE_UNSUPPORTED', 'The current ChatGPT module table could not be inspected safely.');
            }
            if (ids.length > NATIVE_DISCOVERY_MAX_FACTORIES) {
                fail('NATIVE_MODULE_SOURCE_UNSUPPORTED', 'The current ChatGPT module table exceeds the safe discovery limit.');
            }
            return {ids, factories: ids.map(id => moduleMap[id])};
        }

        function sameModuleState(left, right) {
            return left.ids.length === right.ids.length &&
                left.ids.every((id, index) => id === right.ids[index] && left.factories[index] === right.factories[index]);
        }

        function discoverNativeGraph(requireFunction, state) {
            const factories = [];
            const loaders = [];
            let sourceBytes = 0;
            let unsupportedAnchoredSource = false;

            for (let index = 0; index < state.ids.length; index += 1) {
                const factoryFunction = state.factories[index];
                if (typeof factoryFunction !== 'function') continue;
                let source;
                try {
                    source = Function.prototype.toString.call(factoryFunction);
                } catch (_error) {
                    continue;
                }
                if (typeof source !== 'string') continue;
                sourceBytes += source.length;
                if (source.length > 2_000_000 || sourceBytes > NATIVE_DISCOVERY_MAX_SOURCE_BYTES) {
                    fail('NATIVE_MODULE_SOURCE_UNSUPPORTED', 'The current ChatGPT module source exceeds the safe discovery limit.');
                }
                if (
                    !source.includes('chatgpt-conversation-page') ||
                    !source.includes('/conversations/{conversation_id}/messages')
                ) continue;

                let parsed;
                try {
                    parsed = parseFactorySource(state.ids[index], source);
                } catch (_error) {
                    unsupportedAnchoredSource = true;
                    continue;
                }
                if (!parsed.anchorsPresent) continue;
                const candidates = getLoaderCandidates(parsed);
                if (!candidates.length) unsupportedAnchoredSource = true;
                loaders.push(...candidates);
                factories.push(parsed);
            }

            const connected = [];
            if (loaders.length) {
                const loaderIds = new Set(loaders.map(loader => loader.loaderId));
                for (let index = 0; index < state.ids.length; index += 1) {
                    const factoryFunction = state.factories[index];
                    if (typeof factoryFunction !== 'function') continue;
                    let source;
                    try {
                        source = Function.prototype.toString.call(factoryFunction);
                    } catch (_error) {
                        continue;
                    }
                    if (typeof source !== 'string' || ![...loaderIds].some(id => source.includes(id))) continue;
                    if (factories.some(factory => factory.id === state.ids[index])) continue;
                    sourceBytes += source.length;
                    if (source.length > 2_000_000 || sourceBytes > NATIVE_DISCOVERY_MAX_SOURCE_BYTES * 2) {
                        fail('NATIVE_MODULE_SOURCE_UNSUPPORTED', 'The current ChatGPT module source exceeds the safe discovery limit.');
                    }
                    try {
                        factories.push(parseFactorySource(state.ids[index], source));
                    } catch (_error) {
                        unsupportedAnchoredSource = true;
                    }
                }

                for (const loader of loaders) {
                    connected.push(...findComponentGraphs(factories, loader));
                }
            }

            const unique = new Map();
            for (const graph of connected) unique.set(JSON.stringify(graph), graph);
            if (unique.size > 1) {
                fail('NATIVE_MODULE_DISCOVERY_AMBIGUOUS', 'More than one source-linked ChatGPT history module graph was found.');
            }
            if (unique.size === 1) return unique.values().next().value;
            if (unsupportedAnchoredSource || loaders.length) {
                fail('NATIVE_MODULE_SOURCE_UNSUPPORTED', 'The current ChatGPT history module source could not be linked safely.');
            }
            fail('NATIVE_MODULE_DISCOVERY_NOT_FOUND', 'The current ChatGPT history module graph was not found.');
        }

        function getNativeGraph(requireFunction) {
            const state = captureModuleState(requireFunction);
            const cached = NATIVE_DISCOVERY_CACHE.get(requireFunction);
            if (cached && sameModuleState(cached.state, state)) {
                if (cached.error) throw new NativeAdapterError(cached.error.code, cached.error.message);
                return cached.graph;
            }

            try {
                const graph = discoverNativeGraph(requireFunction, state);
                NATIVE_DISCOVERY_CACHE.set(requireFunction, {state, graph, error: null});
                return graph;
            } catch (error) {
                const nativeError = error instanceof NativeAdapterError
                    ? error
                    : new NativeAdapterError('NATIVE_MODULE_SOURCE_UNSUPPORTED', 'The current ChatGPT history module source could not be read safely.');
                NATIVE_DISCOVERY_CACHE.set(requireFunction, {state, graph: null, error: nativeError});
                throw nativeError;
            }
        }

        function isObject(value) {
            return value !== null && typeof value === 'object';
        }

        function asSameOriginAsset(value, windowObject) {
            if (typeof value !== 'string' || !value) return null;

            let url;
            try {
                url = new URL(value, windowObject.location.href);
            } catch (_error) {
                return null;
            }

            if (
                url.origin !== windowObject.location.origin ||
                !url.pathname.startsWith('/cdn/assets/') ||
                !url.pathname.endsWith('.js')
            ) {
                return null;
            }

            return url.href;
        }

        function decodePathSegment(value) {
            try {
                return decodeURIComponent(value);
            } catch (_error) {
                return value;
            }
        }

        function routePatternMatches(routePath, pathname) {
            if (typeof routePath !== 'string' || !routePath || routePath === '*') {
                return false;
            }

            const pattern = routePath.split('/').filter(Boolean);
            const path = pathname.split('/').filter(Boolean);
            if (pattern.length === 0 || pattern.length > path.length) return false;

            const offset = path.length - pattern.length;
            return pattern.every((segment, index) => {
                const pathSegment = decodePathSegment(path[offset + index]);
                if (segment === '*' || segment.startsWith(':')) return Boolean(pathSegment);
                return decodePathSegment(segment) === pathSegment;
            });
        }

        function getRouteAssets(routes, pathname) {
            const routeEntries = Object.entries(routes);
            const routesById = new Map();
            for (const [key, route] of routeEntries) {
                if (isObject(route)) routesById.set(route.id || key, route);
            }

            const activeRoutes = new Set();
            for (const [, route] of routeEntries) {
                if (!isObject(route) || !routePatternMatches(route.path, pathname)) continue;

                let current = route;
                const visited = new Set();
                while (isObject(current) && !visited.has(current)) {
                    visited.add(current);
                    activeRoutes.add(current);
                    current = routesById.get(current.parentId);
                }
            }

            const assets = [];
            for (const route of activeRoutes) {
                if (Array.isArray(route.imports)) assets.push(...route.imports);
                if (typeof route.module === 'string') assets.push(route.module);
            }

            return assets;
        }

        function getModulePreloadUrls(documentObject, windowObject) {
            if (!documentObject || typeof documentObject.querySelectorAll !== 'function') {
                fail('DOCUMENT_UNAVAILABLE', 'The current page document is unavailable.');
            }

            const urls = new Set();
            let links;
            try {
                links = documentObject.querySelectorAll(MODULE_PRELOAD_SELECTOR);
            } catch (_error) {
                return urls;
            }

            for (const link of Array.from(links || [])) {
                const value = link?.href || link?.getAttribute?.('href');
                const url = asSameOriginAsset(value, windowObject);
                if (url) urls.add(url);
            }

            return urls;
        }

        function getRuntimeCandidates(manifest, documentObject, windowObject) {
            const pathname = windowObject.location?.pathname;
            if (typeof pathname !== 'string' || !pathname) {
                fail('CURRENT_ROUTE_UNAVAILABLE', 'The active ChatGPT route could not be identified.');
            }

            /*
             * Module preloads are one evidence source, not a prerequisite.
             * SPA route transitions may not have added preload links yet, and
             * current frontend rollouts do not guarantee them for every route.
             */
            const preloads = getModulePreloadUrls(documentObject, windowObject);
            const scores = new Map();
            for (const url of preloads) {
                scores.set(url, 3);
            }

            if (isObject(manifest) && isObject(manifest.routes)) {
                const routeAssets = getRouteAssets(manifest.routes, pathname);
                if (isObject(manifest.entry) && Array.isArray(manifest.entry.imports)) {
                    routeAssets.push(...manifest.entry.imports);
                }

                for (const asset of routeAssets) {
                    const url = asSameOriginAsset(asset, windowObject);
                    if (!url) continue;
                    scores.set(url, preloads.has(url) ? 5 : 4);
                }
            }

            try {
                const resources = windowObject.performance?.getEntriesByType?.('resource');
                for (const entry of Array.from(resources || [])) {
                    const url = asSameOriginAsset(entry?.name, windowObject);
                    if (url && !scores.has(url)) scores.set(url, 1);
                }
            } catch (_error) {
                /* The performance timeline is optional evidence. */
            }

            if (scores.size === 0) {
                fail(
                    isObject(manifest)
                        ? 'CURRENT_RUNTIME_UNAVAILABLE'
                        : 'ROUTER_MANIFEST_UNAVAILABLE',
                    'No ChatGPT JavaScript assets were available to discover the current runtime.'
                );
            }

            return [...scores.entries()]
                .sort((left, right) => right[1] - left[1])
                .slice(0, MAX_RUNTIME_CANDIDATES)
                .map(([url]) => url);
        }

        function isWebpackRequire(value) {
            return typeof value === 'function' && isObject(value.m);
        }

        let cachedWebpackRequire = null;

        function getRuntimeValidationError(requireFunction) {
            try {
                requireSupportedModules(requireFunction);
                return null;
            } catch (error) {
                return error;
            }
        }

        async function discoverWebpackRequire({
            document: documentObject,
            window: windowObject,
            importModule,
        }) {
            if (!windowObject || !isObject(windowObject.location)) {
                fail('WINDOW_UNAVAILABLE', 'The current ChatGPT window is unavailable.');
            }

            /*
             * Once a runtime works on this page it stays valid for the whole
             * SPA session, including later route transitions. Re-validate
             * against the module contract in case the page reloaded a bundle.
             */
            if (
                cachedWebpackRequire &&
                !getRuntimeValidationError(cachedWebpackRequire)
            ) {
                return cachedWebpackRequire;
            }
            cachedWebpackRequire = null;

            const manifest = windowObject.__reactRouterManifest;
            const candidates = getRuntimeCandidates(manifest, documentObject, windowObject);
            const importer = typeof importModule === 'function'
                ? importModule
                : specifier => import(specifier);

            let lastModuleError = null;
            for (const url of candidates) {
                let namespace;
                try {
                    namespace = await importer(url);
                } catch (_error) {
                    continue;
                }

                const requireFunction = namespace?.__webpack_require__;
                if (!isWebpackRequire(requireFunction)) continue;

                const moduleError = getRuntimeValidationError(requireFunction);
                if (moduleError) {
                    lastModuleError = moduleError;
                    continue;
                }

                cachedWebpackRequire = requireFunction;
                return requireFunction;
            }

            if (lastModuleError) throw lastModuleError;
            fail('SUPPORTED_RUNTIME_NOT_FOUND', 'The current ChatGPT runtime does not expose the supported module loader.');
        }

        function requireSupportedModules(requireFunction) {
            const graph = getNativeGraph(requireFunction);
            const selected = [
                ['scope', graph.scopeId, graph.scopeExport],
                ['conversationState', graph.stateId, graph.stateExport],
                ['pagination', graph.paginationId, graph.paginationExport],
                ['loader', graph.loaderId, graph.loaderExport],
                ['reactDom', graph.reactDomId, graph.reactDomExport],
                ['historySource', graph.historyId, graph.historyExport],
            ];
            const exportsByName = {};
            try {
                for (const [name, id, exportName] of selected) {
                    if (!Object.prototype.hasOwnProperty.call(requireFunction.m, id)) {
                        fail('NATIVE_MODULE_EXPORT_SHAPE_UNKNOWN', 'A source-linked ChatGPT navigation module is missing.');
                    }
                    const namespace = requireFunction(id);
                    exportsByName[name] = namespace?.[exportName];
                }
            } catch (error) {
                if (error instanceof NativeAdapterError) throw error;
                fail('NATIVE_MODULE_EXPORT_SHAPE_UNKNOWN', 'A source-linked ChatGPT navigation module could not be loaded.');
            }

            const scopeToken = exportsByName.scope;
            const conversationStateSelector = exportsByName.conversationState;
            const paginationSelector = exportsByName.pagination;
            const loadPrevious = exportsByName.loader;
            const flushSync = exportsByName.reactDom;
            const historyComponent = exportsByName.historySource;

            if (
                !isObject(scopeToken) ||
                scopeToken.__scopeBrand !== 'AppScope' ||
                typeof scopeToken.id !== 'symbol' ||
                (!isObject(conversationStateSelector) && typeof conversationStateSelector !== 'function') ||
                paginationSelector == null ||
                typeof loadPrevious !== 'function' ||
                typeof flushSync !== 'function' ||
                typeof historyComponent !== 'function'
            ) {
                fail('NATIVE_MODULE_EXPORT_SHAPE_UNKNOWN', 'The current ChatGPT navigation module exports have changed.');
            }

            return {
                scopeToken,
                conversationStateSelector,
                paginationSelector,
                loadPrevious,
                flushSync,
                historyComponent,
            };
        }

        function getCurrentRoot(fiber) {
            let root = fiber;
            let depth = 0;
            while (root?.return && depth < MAX_FIBER_NODES_PER_ROOT) {
                root = root.return;
                depth += 1;
            }
            if (root?.return) return null;

            const rootState = root?.stateNode;
            if (!isObject(rootState) || !('current' in rootState)) return null;
            if (rootState.current !== root && rootState.current !== root?.alternate) return null;
            return isObject(rootState.current) ? rootState.current : null;
        }

        function collectFiberTrees(documentObject) {
            let pageElements;
            try {
                pageElements = documentObject.querySelectorAll('*');
            } catch (_error) {
                fail('REACT_FIBERS_UNAVAILABLE', 'ChatGPT page nodes could not be inspected.');
            }

            const roots = new Set();
            let elementCount = 0;
            function inspectElement(element) {
                elementCount += 1;
                if (elementCount > MAX_PAGE_ELEMENTS) {
                    fail('REACT_FIBER_LIMIT_EXCEEDED', 'The current ChatGPT page is too large to inspect safely.');
                }
                let propertyNames;
                try {
                    propertyNames = Object.getOwnPropertyNames(element);
                } catch (_error) {
                    return;
                }

                for (const propertyName of propertyNames) {
                    if (!REACT_FIBER_PROPERTY_PREFIXES.some(prefix => propertyName.startsWith(prefix))) {
                        continue;
                    }

                    let fiber;
                    try {
                        fiber = element[propertyName];
                    } catch (_error) {
                        continue;
                    }

                    const root = getCurrentRoot(fiber);
                    if (root) roots.add(root);
                }
            }
            if (documentObject.documentElement) inspectElement(documentObject.documentElement);
            for (const element of pageElements || []) inspectElement(element);

            const trees = [];
            for (const root of roots) {
                const fibers = [];
                const seen = new Set();
                const pending = [root];
                while (pending.length > 0) {
                    const fiber = pending.pop();
                    if (!isObject(fiber) || seen.has(fiber)) continue;
                    seen.add(fiber);
                    fibers.push(fiber);
                    if (fibers.length > MAX_FIBER_NODES_PER_ROOT) {
                        fail('REACT_FIBER_LIMIT_EXCEEDED', 'The current ChatGPT page is too large to inspect safely.');
                    }
                    if (isObject(fiber.sibling)) pending.push(fiber.sibling);
                    if (isObject(fiber.child)) pending.push(fiber.child);
                }
                trees.push({root, fibers});
            }

            return trees;
        }

        function getCurrentRef(fiber) {
            const props = fiber?.memoizedProps;
            for (const ref of [fiber?.ref, props?.ref]) {
                if (!isObject(ref) || !('current' in ref)) continue;
                const current = ref.current;
                if (isObject(current) && typeof current.scrollToMessage === 'function') {
                    return current;
                }
            }
            return null;
        }

        function findTarget({fibers, chatId}) {
            const candidates = [];
            for (const fiber of fibers) {
                const props = fiber?.memoizedProps;
                if (
                    !isObject(props) ||
                    props.conversationId !== chatId ||
                    !Array.isArray(props.entries)
                ) {
                    continue;
                }

                const ref = getCurrentRef(fiber);
                if (ref) candidates.push({fiber, props, ref});
            }

            if (candidates.length === 0) return null;
            if (candidates.length > 1) {
                fail('AMBIGUOUS_ACTIVE_CONVERSATION', 'More than one native conversation list matched this chat.');
            }

            return candidates[0];
        }

        function getCachedScopeWrapper(fiber, scopeToken) {
            const wrappers = new Set();
            const visitedHooks = new Set();
            let hook = fiber?.memoizedState;
            while (isObject(hook) && !visitedHooks.has(hook)) {
                visitedHooks.add(hook);
                const ref = hook.memoizedState;
                const wrapper = ref?.current;
                let exactChainBinding = false;
                if (
                    isObject(wrapper) &&
                    isObject(wrapper.node) &&
                    isObject(wrapper.chain) &&
                    typeof wrapper.chain.get === 'function'
                ) {
                    try {
                        exactChainBinding = wrapper.chain.get(scopeToken.id) === wrapper.node;
                    } catch (_error) {
                        exactChainBinding = false;
                    }
                }
                if (
                    isObject(wrapper) &&
                    wrapper.scope === scopeToken &&
                    isObject(wrapper.node) &&
                    wrapper.node.token === scopeToken &&
                    exactChainBinding &&
                    typeof wrapper.get === 'function' &&
                    typeof wrapper.set === 'function' &&
                    typeof wrapper.watch === 'function' &&
                    typeof wrapper.when === 'function'
                ) {
                    wrappers.add(wrapper);
                }
                hook = hook.next;
            }

            if (wrappers.size > 1) {
                fail('AMBIGUOUS_APP_SCOPE_BINDING', 'The native conversation history has multiple AppScope bindings.');
            }
            return wrappers.values().next().value || null;
        }

        function findAppScopeBinding({fibers, chatId, historyComponent, scopeToken}) {
            const bindings = new Map();
            for (const fiber of fibers) {
                if (
                    (fiber?.type !== historyComponent && fiber?.elementType !== historyComponent) ||
                    fiber.memoizedProps?.conversationId !== chatId
                ) {
                    continue;
                }

                const wrapper = getCachedScopeWrapper(fiber, scopeToken);
                if (wrapper && !bindings.has(wrapper)) bindings.set(wrapper, fiber);
            }

            if (bindings.size === 0) return null;
            if (bindings.size > 1) {
                const [first, ...rest] = bindings.keys();
                if (rest.some(binding => binding.node !== first.node || binding.chain !== first.chain)) {
                    fail('AMBIGUOUS_APP_SCOPE_BINDING', 'More than one native AppScope binding matched this conversation.');
                }
            }
            const [scope, fiber] = bindings.entries().next().value;
            return {scope, fiber};
        }

        function getConversationStateKey({scope, chatId, modules}) {
            let value;
            try {
                /* Mirrors M3K: DF.x(Mr.j, conversationId); pagination has a separate fallback. */
                value = scope.get(modules.conversationStateSelector, chatId);
            } catch (_error) {
                fail('NATIVE_CONVERSATION_STATE_UNAVAILABLE', 'The active ChatGPT conversation state could not be read.');
            }

            if (value == null) return null;
            if (typeof value !== 'string') {
                fail('UNSUPPORTED_CONVERSATION_STATE', 'The active ChatGPT conversation state has an unsupported value.');
            }

            return value;
        }

        function getRawPagination(scope, selector, paginationKey) {
            let value;
            try {
                value = scope.get(selector, paginationKey);
            } catch (_error) {
                fail('NATIVE_PAGINATION_UNAVAILABLE', 'ChatGPT pagination state could not be read.');
            }

            /*
             * A conversation without older pages (for example a short chat)
             * never initializes pagination state. "Missing" is a valid
             * capability answer, not a failure.
             */
            if (value == null) return null;
            if (!isObject(value)) {
                fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT pagination state has an unsupported shape.');
            }
            if (typeof value.complete !== 'boolean') {
                fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT pagination completion state has an unsupported shape.');
            }
            if (value.cursor !== null && typeof value.cursor !== 'string') {
                fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT pagination cursor has an unsupported shape.');
            }
            if (typeof value.hasError !== 'boolean') {
                fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT pagination error state has an unsupported shape.');
            }
            if (typeof value.isLoading !== 'boolean') {
                fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT pagination loading state has an unsupported shape.');
            }
            if (
                value.hasLoadedOlderPages !== undefined &&
                typeof value.hasLoadedOlderPages !== 'boolean'
            ) {
                fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT older-page completion state has an unsupported shape.');
            }
            if (value.oldestMessageId != null && typeof value.oldestMessageId !== 'string') {
                fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT oldest message identifier has an unsupported shape.');
            }

            return value;
        }

        function normalizeNativePagination(rawPagination) {
            if (rawPagination == null) {
                return {
                    available: false,
                    complete: false,
                    cursor: null,
                    hasError: false,
                    isLoading: false,
                    canLoadPrevious: false
                };
            }

            const hasError = rawPagination.hasError === true;
            const isLoading = rawPagination.isLoading === true;
            const cursor = rawPagination.cursor ?? null;
            const canUseTerminalCursor = cursor === null &&
                rawPagination.hasLoadedOlderPages === true;
            const complete = !hasError && !isLoading &&
                (rawPagination.complete === true || canUseTerminalCursor);

            return {
                available: true,
                complete,
                cursor,
                hasError,
                isLoading,
                canLoadPrevious: !isLoading && !complete &&
                    typeof cursor === 'string'
            };
        }

        function flattenConversationItems(items, output = []) {
            for (const item of items) {
                if (item?.type === 'chatgpt-reasoning-group' && Array.isArray(item.items)) {
                    flattenConversationItems(item.items, output);
                } else {
                    output.push(item);
                }
            }
            return output;
        }

        function collectItemMessageId(item) {
            if (item.messageId == null) return null;
            if (typeof item.messageId !== 'string' || item.messageId.length === 0) {
                fail('UNSUPPORTED_TURN_MODEL', 'A native conversation message identifier has an unsupported shape.');
            }
            return item.messageId;
        }

        function resolveNativeAssistantContent(item) {
            const content = item.content;
            const references = Array.isArray(item.contentReferences)
                ? item.contentReferences
                : [];
            const messageId = collectItemMessageId(item);
            const sourceIds = [];
            const unresolvedIds = [];
            const markerPattern = /::chatgpt-content-reference\{([^{}]*)\}/g;
            const hasReferenceMarker = content.includes('::chatgpt-content-reference');
            let foundMarker = false;
            let allResolved = true;
            let resolvedText = '';
            let previousIndex = 0;

            for (const match of content.matchAll(markerPattern)) {
                foundMarker = true;
                resolvedText += content.slice(previousIndex, match.index);
                const indexValue = match[1].match(/(?:^|\s)index="(\d+)"(?=\s|$)/)?.[1];
                const sourceMessageId = match[1].match(/(?:^|\s)source_message_id="([^"]+)"(?=\s|$)/)?.[1];
                const referenceIndex = indexValue === undefined ? NaN : Number(indexValue);
                const reference = Number.isSafeInteger(referenceIndex) && referenceIndex >= 0
                    ? references[referenceIndex]
                    : null;
                const fallbackMarkdown = reference?.model_dil_v2?.fallbackMarkdown;
                const resolves = Boolean(
                    sourceMessageId &&
                    (!messageId || messageId === sourceMessageId) &&
                    reference?.type === 'dil' &&
                    reference.source_message_id === sourceMessageId &&
                    reference.source_message_status === 'finished_successfully' &&
                    typeof fallbackMarkdown === 'string'
                );

                if (resolves) {
                    resolvedText += fallbackMarkdown;
                    sourceIds.push(sourceMessageId);
                } else {
                    resolvedText += match[0];
                    allResolved = false;
                    const unresolvedId = messageId || sourceMessageId;
                    if (unresolvedId) unresolvedIds.push(unresolvedId);
                }
                previousIndex = match.index + match[0].length;
            }

            resolvedText += content.slice(previousIndex);
            if (hasReferenceMarker && !foundMarker) {
                allResolved = false;
                if (messageId) unresolvedIds.push(messageId);
            }

            return {
                text: resolvedText,
                hasReference: hasReferenceMarker,
                complete: hasReferenceMarker && foundMarker && allResolved,
                sourceIds: uniqueMessageIds(sourceIds),
                unresolvedIds: uniqueMessageIds(unresolvedIds),
            };
        }

        function mapNativeEntries(entries, chatId) {
            const mapped = [];
            for (const entry of entries) {
                if (!isObject(entry) || !isObject(entry.turn)) {
                    fail('UNSUPPORTED_TURN_MODEL', 'A native conversation row has an unsupported shape.');
                }

                const {turn} = entry;
                if (
                    typeof entry.turnKey !== 'string' ||
                    entry.turnKey.length === 0 ||
                    !Array.isArray(turn.messageIds) ||
                    !Array.isArray(turn.items)
                ) {
                    fail('UNSUPPORTED_TURN_MODEL', 'A native conversation turn has an unsupported shape.');
                }
                if (turn.messageIds.some(id => typeof id !== 'string' || id.length === 0)) {
                    fail('UNSUPPORTED_TURN_MODEL', 'A native turn message list has an unsupported shape.');
                }

                const userItems = [];
                const assistantItems = [];
                const assistantContent = [];
                for (const item of flattenConversationItems(turn.items)) {
                    if (!isObject(item)) continue;
                    if (item.type === 'user-message') {
                        if (typeof item.message !== 'string') {
                            fail('UNSUPPORTED_TURN_MODEL', 'A native user message has an unsupported content shape.');
                        }
                        userItems.push(item);
                    } else if (item.type === 'assistant-message') {
                        if (typeof item.content !== 'string') {
                            fail('UNSUPPORTED_TURN_MODEL', 'A native assistant message has an unsupported content shape.');
                        }
                        assistantItems.push(item);
                        assistantContent.push(resolveNativeAssistantContent(item));
                    }
                }

                if (userItems.length === 0 && assistantItems.length === 0) continue;

                const userMessageIds = userItems
                    .map(collectItemMessageId)
                    .filter(Boolean);
                const assistantMessageIds = uniqueMessageIds([
                    ...assistantItems.map(collectItemMessageId).filter(Boolean),
                    ...assistantContent.flatMap(content => content.sourceIds),
                ]);
                const assistantTextHasReferences = assistantContent.some(content => content.hasReference);
                const assistantTextHasOnlyResolvedReferences = assistantContent.every(content =>
                    !content.hasReference || content.complete
                );
                const userMessageId = userMessageIds[0];
                const messageId = assistantMessageIds[0] || userMessageId || null;
                const turnKey = entry.turnKey;
                const kind = userItems.length > 0 ? 'user' : 'assistant';
                const identity = kind === 'user'
                    ? `user:${turnKey}`
                    : `assistant:round:${JSON.stringify([turnKey, `${turnKey}:assistant`])}`;

                const mappedEntry = {
                    identity,
                    turnKey,
                    kind,
                    messageId,
                    assistantMessageIds,
                    userText: userItems.map(item => item.message).join('\n\n'),
                    assistantText: assistantContent.map(content => content.text).join('\n\n'),
                    assistantTextSource: assistantTextHasReferences
                        ? assistantTextHasOnlyResolvedReferences ? 'native-complete' : 'native-reference'
                        : 'native-plain',
                    assistantTextSourceMessageIds: assistantTextHasOnlyResolvedReferences
                        ? uniqueMessageIds(assistantContent.flatMap(content => content.sourceIds))
                        : [],
                    assistantTextUnresolvedReferenceMessageIds: uniqueMessageIds(
                        assistantContent.flatMap(content => content.unresolvedIds)
                    ),
                };
                if (userMessageId) mappedEntry.userMessageId = userMessageId;
                if (userMessageIds.length > 1) mappedEntry.userMessageIds = userMessageIds;
                mapped.push(mappedEntry);
            }

            const lastEntry = entries.at(-1);
            const lastTurnKey = typeof lastEntry?.turnKey === 'string'
                ? lastEntry.turnKey
                : 'empty';
            const lastEntryId = typeof lastEntry?.id === 'string'
                ? lastEntry.id
                : lastTurnKey;

            return {
                chatId,
                entries: mapped,
                branchKey: `${chatId}:${lastEntryId}:${lastTurnKey}`,
            };
        }

        function resolveNativeTarget(documentObject, chatId) {
            const targets = [];
            for (const tree of collectFiberTrees(documentObject)) {
                const target = findTarget({fibers: tree.fibers, chatId});
                if (target) targets.push({tree, target});
            }
            if (targets.length === 0) {
                fail('ACTIVE_CONVERSATION_NOT_FOUND', 'The native conversation list for this chat is unavailable.');
            }
            if (targets.length > 1) {
                fail('AMBIGUOUS_ACTIVE_CONVERSATION', 'More than one native conversation list matched this chat.');
            }
            return targets[0];
        }

        function getRouteConversationId(windowObject) {
            const pathname = windowObject?.location?.pathname;
            return typeof pathname === 'string'
                ? pathname.match(/(?:^|\/)c\/([^/]+)/)?.[1] || null
                : null;
        }

        function createNativeLocator({
            document: documentObject,
            window: windowObject,
            chatId: requestedChatId,
            isCurrent = () => true
        } = {}) {
            if (typeof requestedChatId !== 'string' || requestedChatId.length === 0) {
                fail('INVALID_CHAT_ID', 'A conversation identifier is required.');
            }
            let disposed = false;

            function assertActive() {
                if (disposed) fail('LOCATOR_DISPOSED', 'This native message locator has been disposed.');
                if (
                    getRouteConversationId(windowObject) !== requestedChatId ||
                    !isCurrent()
                ) {
                    fail('STALE_NATIVE_LOCATOR', 'The active ChatGPT conversation changed before navigation.');
                }
            }

            function resolveCurrentTarget() {
                assertActive();
                return resolveNativeTarget(documentObject, requestedChatId).target;
            }

            async function locateMessage(messageId, isRequestCurrent = () => true) {
                if (typeof messageId !== 'string' || messageId.length === 0) {
                    fail('INVALID_MESSAGE_ID', 'A message identifier is required.');
                }
                const target = resolveCurrentTarget();
                const entries = target.props.entries;
                if (!Array.isArray(entries)) {
                    fail('UNSUPPORTED_TURN_MODEL', 'The native conversation list has an unsupported shape.');
                }
                const hasMessage = entries.some(entry =>
                    Array.isArray(entry?.turn?.messageIds) &&
                    entry.turn.messageIds.includes(messageId)
                );
                if (!hasMessage) return false;

                assertActive();
                if (!isRequestCurrent()) return false;
                try {
                    await target.ref.scrollToMessage(messageId);
                } catch (_error) {
                    fail('NATIVE_SCROLL_FAILED', 'ChatGPT could not scroll to the requested message.');
                }
                assertActive();
                if (!isRequestCurrent()) return false;

                const currentTarget = resolveCurrentTarget();
                const currentEntries = currentTarget.props.entries;
                if (!Array.isArray(currentEntries)) return false;
                return currentEntries.some(entry =>
                    Array.isArray(entry?.turn?.messageIds) &&
                    entry.turn.messageIds.includes(messageId)
                ) && Boolean(isRequestCurrent());
            }

            resolveCurrentTarget();
            return {
                locateMessage,
                dispose() {
                    disposed = true;
                }
            };
        }

        function createNativeAdapterErrorFrom(error, code, message) {
            if (error instanceof NativeAdapterError) return error;
            return new NativeAdapterError(code, message);
        }

        async function createNativeAdapter({
            document: documentObject,
            window: windowObject,
            chatId: requestedChatId,
            importModule,
        } = {}) {
            if (typeof requestedChatId !== 'string' || requestedChatId.length === 0) {
                fail('INVALID_CHAT_ID', 'A conversation identifier is required.');
            }

            const requireFunction = await discoverWebpackRequire({
                document: documentObject,
                window: windowObject,
                importModule,
            });
            const modules = requireSupportedModules(requireFunction);

            let disposed = false;
            let pendingLoad = null;

            function assertActive() {
                if (disposed) fail('ADAPTER_DISPOSED', 'This native navigation adapter has been disposed.');
            }

            function resolveCurrentState() {
                assertActive();
                if (getRouteConversationId(windowObject) !== requestedChatId) {
                    fail('STALE_NATIVE_ADAPTER', 'The active ChatGPT conversation changed during page loading.');
                }
                const {tree, target} = resolveNativeTarget(documentObject, requestedChatId);
                const binding = findAppScopeBinding({
                    fibers: tree.fibers,
                    chatId: requestedChatId,
                    historyComponent: modules.historyComponent,
                    scopeToken: modules.scopeToken,
                });
                if (!binding) {
                    fail('APP_SCOPE_BINDING_UNAVAILABLE', 'The native AppScope binding for this conversation is unavailable.');
                }
                const {scope, fiber: scopeFiber} = binding;
                const conversationStateKey = getConversationStateKey({
                    scope,
                    chatId: requestedChatId,
                    modules,
                });
                const paginationKey = conversationStateKey ?? requestedChatId;
                const rawPagination = getRawPagination(
                    scope,
                    modules.paginationSelector,
                    paginationKey
                );
                const pagination = normalizeNativePagination(rawPagination);

                return {
                    root: tree.root,
                    target,
                    scope,
                    scopeFiber,
                    conversationStateKey,
                    rawPagination,
                    pagination
                };
            }

            function readSnapshot() {
                const {target, pagination} = resolveCurrentState();
                if (!Array.isArray(target.props.entries)) {
                    fail('UNSUPPORTED_TURN_MODEL', 'The native conversation list has an unsupported shape.');
                }

                const snapshot = mapNativeEntries(target.props.entries, requestedChatId);
                snapshot.pagination = pagination;
                return snapshot;
            }

            function getCurrentTimer() {
                const timer = windowObject?.setTimeout || globalThis.setTimeout;
                return timer.bind(windowObject || globalThis);
            }

            async function waitForPaginationIdle(initialState, baseline) {
                const setTimer = getCurrentTimer();
                const startedAt = Date.now();
                const {scope, conversationStateKey} = initialState;
                let current = initialState;
                while (true) {
                    assertActive();
                    if (getRouteConversationId(windowObject) !== requestedChatId) {
                        fail('STALE_NATIVE_ADAPTER', 'The active ChatGPT conversation changed during page loading.');
                    }

                    /* Reuse a verified binding only within this page request. */
                    if (
                        getCurrentRoot(current.target.fiber) !== current.root ||
                        getCurrentRoot(current.scopeFiber) !== current.root ||
                        current.target.fiber.memoizedProps?.conversationId !== requestedChatId ||
                        getCachedScopeWrapper(current.scopeFiber, modules.scopeToken) !== scope
                    ) {
                        current = resolveCurrentState();
                    }
                    const currentKey = getConversationStateKey({scope: current.scope,
                        chatId: requestedChatId, modules});
                    if (current.scope !== scope || currentKey !== conversationStateKey) {
                        fail('STALE_NATIVE_ADAPTER', 'The active ChatGPT conversation changed during page loading.');
                    }
                    let pagination = normalizeNativePagination(getRawPagination(
                        scope, modules.paginationSelector, conversationStateKey
                    ));
                    if (!pagination.isLoading) {
                        /* Recheck uniqueness across all roots before accepting progress. */
                        current = resolveCurrentState();
                        if (current.scope !== scope || current.conversationStateKey !== conversationStateKey) {
                            fail('STALE_NATIVE_ADAPTER', 'The active ChatGPT conversation changed during page loading.');
                        }
                        pagination = current.pagination;
                        if (!pagination.isLoading) {
                            const entriesAdvanced = current.target.props.entries.length > baseline.entryCount;
                            const cursorAdvanced = pagination.cursor !== baseline.cursor;
                            const completionChanged = pagination.complete !== baseline.complete;
                            const loadFailed = pagination.hasError && baseline.hasError !== true;
                            if (entriesAdvanced || cursorAdvanced || completionChanged || loadFailed) return;
                            fail('NATIVE_PAGE_NO_PROGRESS', 'ChatGPT finished the page request without advancing its conversation history.');
                        }
                    }
                    if (Date.now() - startedAt >= PAGE_LOAD_WAIT_MS) {
                        fail('NATIVE_PAGE_LOAD_TIMEOUT', 'ChatGPT did not finish loading the previous page in time.');
                    }
                    await new Promise(resolve => setTimer(resolve, PAGE_LOAD_POLL_MS));
                }
            }

            async function performLoadPreviousPage() {
                const initialState = resolveCurrentState();
                const {
                    target,
                    scope,
                    conversationStateKey,
                    rawPagination,
                    pagination
                } = initialState;
                if (pagination.complete) {
                    return readSnapshot();
                }

                /* Nothing proves that older pages exist for this conversation. */
                if (!pagination.available) {
                    return readSnapshot();
                }

                if (conversationStateKey == null) {
                    if (rawPagination.cursor == null && rawPagination.isLoading !== true) {
                        return readSnapshot();
                    }
                    fail('NATIVE_CONVERSATION_STATE_UNAVAILABLE', 'ChatGPT cannot load the previous page without its native conversation state.');
                }

                const baseline = {
                    cursor: pagination.cursor,
                    complete: pagination.complete,
                    hasError: pagination.hasError,
                    entryCount: target.props.entries.length,
                };

                if (rawPagination.isLoading === true) {
                    await waitForPaginationIdle(initialState, baseline);
                    return readSnapshot();
                }

                if (!pagination.canLoadPrevious) return readSnapshot();

                if (rawPagination.oldestMessageId == null) {
                    fail('UNSUPPORTED_PAGINATION_SHAPE', 'ChatGPT cannot load the previous page without its oldest message identifier.');
                }

                try {
                    await modules.loadPrevious(scope, conversationStateKey, modules.flushSync);
                } catch (error) {
                    throw createNativeAdapterErrorFrom(
                        error,
                        'NATIVE_PAGE_LOAD_FAILED',
                        'ChatGPT failed to load the previous conversation page.'
                    );
                }

                await waitForPaginationIdle(initialState, baseline);
                return readSnapshot();
            }

            async function loadPreviousPage() {
                assertActive();
                if (pendingLoad) return pendingLoad;

                pendingLoad = performLoadPreviousPage();
                try {
                    return await pendingLoad;
                } finally {
                    pendingLoad = null;
                }
            }

            const adapter = {
                readSnapshot,
                loadPreviousPage,
                dispose() {
                    disposed = true;
                },
            };

            /* Fail during construction when the current route or native model is stale. */
            adapter.readSnapshot();
            return adapter;
        }
        return { createNativeAdapter, createNativeLocator, NativeAdapterError };
    })();
    function chooseCurrentReplyCandidate(candidates) {
        let best = null;
        let bestDistance = Infinity;

        for (const candidate of candidates || []) {
            const rect = candidate?.rect;
            const top = Number(rect?.top);
            const bottom = Number(rect?.bottom);
            const left = Number(rect?.left);
            const right = Number(rect?.right);
            const visibleTop = Number(candidate?.visibleTop);
            const visibleBottom = Number(candidate?.visibleBottom);
            const visibleLeft = Number(candidate?.visibleLeft ?? -Infinity);
            const visibleRight = Number(candidate?.visibleRight ?? Infinity);
            const readingY = Number(candidate?.readingY);
            if (
                !Number.isFinite(top) || !Number.isFinite(bottom) ||
                !Number.isFinite(left) || !Number.isFinite(right) ||
                !Number.isFinite(visibleTop) ||
                !Number.isFinite(visibleBottom) ||
                !Number.isFinite(readingY) ||
                bottom <= top || right <= left ||
                bottom <= visibleTop || top >= visibleBottom ||
                right <= visibleLeft || left >= visibleRight
            ) {
                continue;
            }

            const boundedReadingY = Math.max(
                visibleTop,
                Math.min(visibleBottom, readingY)
            );
            const distance = boundedReadingY < top
                ? top - boundedReadingY
                : boundedReadingY > bottom
                    ? boundedReadingY - bottom
                    : 0;
            if (distance < bestDistance) {
                best = {
                    ...candidate,
                    readingY: boundedReadingY,
                    pointInside: distance === 0
                };
                bestDistance = distance;
            }
        }

        return best;
    }

    function chooseAdjacentReplyHeading(headings, edgeY, direction, tolerance = 1) {
        const edge = Number(edgeY);
        if (!Number.isFinite(edge)) return null;
        const upward = direction === 'up' || direction === -1;
        const candidates = (headings || []).filter(heading => {
            const top = Number(heading?.top);
            return Number.isFinite(top) && (upward
                ? top < edge - tolerance
                : top > edge + tolerance);
        });
        candidates.sort((left, right) => upward
            ? Number(right.top) - Number(left.top)
            : Number(left.top) - Number(right.top));
        return candidates[0] || null;
    }

    function computeReplyScrollDelta({
        targetTop,
        targetBottom,
        viewportTop,
        viewportBottom,
        topInset = 0,
        bottomInset = 0,
        edge = 'top'
    }) {
        return edge === 'bottom'
            ? Number(targetBottom) - (Number(viewportBottom) - Number(bottomInset))
            : Number(targetTop) - (Number(viewportTop) + Number(topInset));
    }

    function getRequiredScrollExtension(desiredTop, maxTop) {
        return Math.max(0, Number(desiredTop) - Number(maxTop));
    }

    function collectFixedPositionAncestors(
        elements,
        boundary,
        body,
        getPosition,
        shouldExclude = null,
        acceptedPositions = ['fixed', 'sticky']
    ) {
        const overlays = new Set();
        for (const element of elements || []) {
            for (
                let ancestor = element;
                ancestor && ancestor !== body;
                ancestor = ancestor.parentElement
            ) {
                const position = getPosition(ancestor);
                if (
                    acceptedPositions.includes(position) &&
                    !shouldExclude?.(ancestor)
                ) {
                    overlays.add(ancestor);
                }
                if (ancestor === boundary) break;
            }
        }
        return [...overlays];
    }

    function computeBottomOverlayInset(
        overlays,
        viewport,
        targetX,
        targetRect = null
    ) {
        let inset = 0;
        let composerInset = 0;
        for (const overlay of overlays || []) {
            const rect = overlay?.rect;
            if (
                !(overlay?.position === 'fixed' ||
                    overlay?.position === 'sticky' ||
                    (overlay?.kind === 'composer' &&
                        overlay?.position === 'absolute')) ||
                !Number.isFinite(Number(rect?.left)) ||
                !Number.isFinite(Number(rect?.right)) ||
                !Number.isFinite(Number(rect?.top)) ||
                !Number.isFinite(Number(rect?.bottom)) ||
                (targetRect
                    ? rect.right <= targetRect.left ||
                        rect.left >= targetRect.right ||
                        rect.right <= viewport.left ||
                        rect.left >= viewport.right
                    : rect.left > targetX || rect.right <= targetX) ||
                rect.top >= viewport.bottom || rect.bottom <= viewport.top
            ) {
                continue;
            }
            const visibleTop = Math.max(viewport.top, rect.top);
            if (overlay.kind === 'composer') {
                if (!composerInset) {
                    composerInset = viewport.bottom - visibleTop + 14;
                }
                continue;
            }
            if (
                rect.top >= viewport.bottom ||
                rect.bottom < viewport.bottom - 2 ||
                rect.bottom <= viewport.top
            ) {
                continue;
            }
            inset = Math.max(inset, viewport.bottom - visibleTop + 8);
        }
        return Math.ceil(Math.max(inset, composerInset));
    }

    function clipReplyScrollViewportGeometry(rect, viewportWidth, viewportHeight) {
        const left = Math.min(viewportWidth, Math.max(0, Number(rect.left)));
        const right = Math.max(
            left,
            Math.min(viewportWidth, Number(rect.right))
        );
        const top = Math.min(viewportHeight, Math.max(0, Number(rect.top)));
        const bottom = Math.max(
            top,
            Math.min(viewportHeight, Number(rect.bottom))
        );
        return {left, right, top, bottom, height: bottom - top};
    }

    function computeReplyToolbarPosition({
        windowWidth,
        windowHeight,
        viewportLeft = 0,
        viewportRight = null,
        contentLeft,
        sidebarLeft = null,
        sidebarRight = null,
        sidebarVisible = false,
        toolbarWidth = 32,
        toolbarHeight = 202,
        sidebarGap = 12,
        minimumGutter = 48,
        viewportInset = 8
    }) {
        const width = Number(windowWidth);
        const height = Number(windowHeight);
        const leftEdge = Math.max(0, Number(viewportLeft));
        const rightEdge = viewportRight === null
            ? width
            : Number(viewportRight);
        const contentEdge = Number(contentLeft);
        const sideLeft = Number(sidebarLeft);
        const sideRight = Number(sidebarRight);
        const controlWidth = Number(toolbarWidth);
        const controlHeight = Number(toolbarHeight);
        const gap = Number(sidebarGap);
        const gutter = Number(minimumGutter);
        const inset = Number(viewportInset);
        const hasSidebar = Boolean(
            sidebarVisible && Number.isFinite(sideLeft) &&
            Number.isFinite(sideRight) && sideRight > sideLeft &&
            sideRight > 0 && sideLeft < width
        );
        const left = hasSidebar ? sideRight + gap : leftEdge + gap;
        if (
            ![width, height, leftEdge, rightEdge, contentEdge, left,
                controlWidth, controlHeight, gap, gutter, inset]
                .every(Number.isFinite) ||
            width <= 0 || height <= 0 || controlWidth <= 0 ||
            controlHeight <= 0 || rightEdge <= leftEdge ||
            gap < 0 || gutter < controlWidth + 8 || inset < 0 ||
            left < inset || left + controlWidth > rightEdge - inset ||
            contentEdge - left < gutter || height < controlHeight + inset * 2
        ) {
            return null;
        }

        const top = (height - controlHeight) / 2;
        return {left, top};
    }

    function computeReplyOutlineTogglePosition({
        windowWidth,
        windowHeight,
        toolbarLeft,
        toolbarTop,
        toolbarWidth = 32,
        toggleWidth = 32,
        toggleHeight = 32,
        buttonGap = 32,
        viewportInset = 8
    }) {
        const width = Number(windowWidth);
        const height = Number(windowHeight);
        const left = Number(toolbarLeft);
        const top = Number(toolbarTop);
        const barWidth = Number(toolbarWidth);
        const controlWidth = Number(toggleWidth);
        const controlHeight = Number(toggleHeight);
        const gap = Number(buttonGap);
        const inset = Number(viewportInset);
        if (
            ![width, height, left, top, barWidth, controlWidth,
                controlHeight, gap, inset].every(Number.isFinite) ||
            width <= 0 || height <= 0 || barWidth <= 0 ||
            controlWidth <= 0 || controlHeight <= 0 ||
            gap < 0 || inset < 0
        ) {
            return null;
        }
        const requestedLeft = left + (barWidth - controlWidth) / 2;
        const requestedTop = top - gap - controlHeight;
        return {
            left: Math.max(
                inset,
                Math.min(width - inset - controlWidth, requestedLeft)
            ),
            top: Math.max(
                inset,
                Math.min(height - inset - controlHeight, requestedTop)
            ),
            visible: width > controlWidth + inset * 2 &&
                height > controlHeight + inset * 2
        };
    }

    function computeReplyOutlinePosition({
        windowWidth,
        windowHeight,
        toolbarLeft,
        toolbarWidth = 32,
        preferredWidth = 300,
        preferredHeight = 560,
        viewportInset = 8,
        toolbarGap = 12
    }) {
        const width = Number(windowWidth);
        const height = Number(windowHeight);
        const triggerLeft = Number(toolbarLeft);
        const triggerWidth = Number(toolbarWidth);
        const inset = Number(viewportInset);
        const gap = Number(toolbarGap);
        if (
            ![width, height, triggerLeft, triggerWidth, inset, gap]
                .every(Number.isFinite) ||
            width <= 0 || height <= 0 || triggerWidth <= 0 ||
            inset < 0 || gap < 0
        ) {
            return null;
        }
        const left = Math.max(
            inset,
            Math.min(width - inset, triggerLeft + triggerWidth + gap)
        );
        const availableWidth = Math.max(0, width - inset - left);
        const panelWidth = Math.max(0, Math.min(
            Number(preferredWidth),
            width - inset * 2,
            availableWidth
        ));
        const maxHeight = Math.max(0, Math.min(
            Number(preferredHeight),
            height - inset * 2
        ));
        return {
            left,
            width: panelWidth,
            maxHeight,
            visible: panelWidth > 0 && maxHeight > 0
        };
    }

    function computeReplyOutlineTooltipPosition({
        windowWidth,
        windowHeight,
        anchorLeft,
        anchorRight,
        anchorTop,
        anchorHeight,
        tooltipWidth,
        tooltipHeight,
        viewportInset = 8,
        anchorGap = 16
    }) {
        const width = Number(windowWidth);
        const height = Number(windowHeight);
        const leftEdge = Number(anchorLeft);
        const rightEdge = Number(anchorRight);
        const topEdge = Number(anchorTop);
        const anchorSize = Number(anchorHeight);
        const pillWidth = Number(tooltipWidth);
        const pillHeight = Number(tooltipHeight);
        const inset = Number(viewportInset);
        const gap = Number(anchorGap);
        if (
            ![width, height, leftEdge, rightEdge, topEdge, anchorSize,
                pillWidth, pillHeight, inset, gap].every(Number.isFinite) ||
            width <= 0 || height <= 0 || rightEdge < leftEdge ||
            anchorSize <= 0 || pillWidth <= 0 || pillHeight <= 0 ||
            inset < 0 || gap < 0
        ) {
            return null;
        }
        const clampedWidth = Math.min(pillWidth, width - inset * 2);
        const clampedHeight = Math.min(pillHeight, height - inset * 2);
        const left = Math.max(
            inset,
            Math.min(width - clampedWidth - inset, rightEdge + gap)
        );
        const top = Math.max(
            inset,
            Math.min(
                height - clampedHeight - inset,
                topEdge + (anchorSize - clampedHeight) / 2
            )
        );
        return {left, top, width: clampedWidth, height: clampedHeight};
    }

    function computeReplyContentShift({
        contentRight,
        rightBoundary,
        contentGap = 8,
        preferredShift = 154
    }) {
        const right = Number(contentRight);
        const boundary = Number(rightBoundary);
        const gap = Number(contentGap);
        const shift = Number(preferredShift);
        if (
            ![right, boundary, gap, shift]
                .every(Number.isFinite) ||
            gap < 0 || shift <= 0
        ) {
            return 0;
        }
        const available = Math.max(0, boundary - gap - right);
        return available >= shift ? Math.floor(shift) : 0;
    }

    function computeReplyOutlineTop({
        windowHeight,
        panelHeight,
        toggleTop = null,
        viewportInset = 8
    }) {
        const height = Number(windowHeight);
        const panel = Number(panelHeight);
        const inset = Number(viewportInset);
        const buttonTop = toggleTop === null ? NaN : Number(toggleTop);
        if (
            ![height, panel, inset].every(Number.isFinite) ||
            height <= 0 || panel <= 0 || inset < 0
        ) {
            return null;
        }
        const maxTop = Math.max(inset, height - inset - panel);
        const centeredTop = Math.max(
            inset,
            Math.min(maxTop, (height - panel) / 2)
        );
        if (!Number.isFinite(buttonTop) || centeredTop <= buttonTop) {
            return centeredTop;
        }
        return Math.max(inset, Math.min(maxTop, buttonTop));
    }

    function composeThreadContentX(baseValue, shift) {
        const base = typeof baseValue === 'string' ? baseValue.trim() : '';
        const pixels = Number(shift);
        if (!Number.isFinite(pixels) || pixels <= 0) return base;
        if (!base || base === 'initial') return `${pixels}px`;
        const pixelMatch = base.match(/^([-+]?(?:\d+\.?\d*|\.\d+))px$/);
        if (pixelMatch) {
            const combined = Number(pixelMatch[1]) + pixels;
            const normalized = Number.isInteger(combined)
                ? String(combined)
                : combined.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
            return `${normalized}px`;
        }
        return `calc(${base} + ${pixels}px)`;
    }

    const core = {
        createConversationIndex,
        createHistoryLoader,
        createNativeLocator,
        createNativeAdapter,
        runBoundedScrollSearch,
        deriveHistoryControlView,
        chooseCurrentReplyCandidate,
        chooseAdjacentReplyHeading,
        computeReplyScrollDelta,
        getRequiredScrollExtension,
        collectFixedPositionAncestors,
        computeBottomOverlayInset,
        clipReplyScrollViewportGeometry,
        computeReplyToolbarPosition,
        computeReplyOutlineTogglePosition,
        computeReplyOutlinePosition,
        computeReplyOutlineTooltipPosition,
        computeReplyOutlineTop,
        computeReplyContentShift,
        composeThreadContentX,
        NativeAdapterError
    };
    if (typeof module === 'object' && module?.exports &&
        typeof document === 'undefined') {
        module.exports = core;
        return;
    }
    'use strict';

    const RAIL_ID = 'yw-chatgpt-turn-rail';
    const PREVIEW_ID = 'yw-chatgpt-turn-preview';
    const STYLE_ID = 'yw-chatgpt-turn-nav-style';
    const REPLY_NAV_ID = 'yw-chatgpt-reply-navigation';
    const REPLY_OUTLINE_PINNED_STORAGE_KEY =
        'yw-chatgpt-conversation-navigator:reply-outline-pinned';
    const REPLY_OUTLINE_OPEN_STORAGE_KEY =
        'yw-chatgpt-conversation-navigator:reply-outline-open';
    const REPLY_NAV_CONTROL_SIZE = 32;
    const REPLY_NAV_TOOLBAR_HEIGHT = 202;
    const REPLY_NAV_TOOLBAR_GAP = 12;
    const REPLY_NAV_VIEWPORT_INSET = 8;
    const REPLY_OUTLINE_BUTTON_GAP = REPLY_NAV_CONTROL_SIZE;
    const REPLY_OUTLINE_CONTENT_GAP = 8;
    const REPLY_OUTLINE_CONTENT_SHIFT = 154;
    const REPLY_OUTLINE_CONTENT_SHIFT_DURATION_MS = 100;
    const REPLY_NAV_TOOLTIP_GAP = 16;
    /*
     * Reply navigation icon path notices.
     * Lucide paths (ISC License):
     * Copyright (c) 2026 Lucide Icons and Contributors
     * Permission to use, copy, modify, and/or distribute this software for any
     * purpose with or without fee is hereby granted, provided that the above
     * copyright notice and this permission notice appear in all copies.
     * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
     * WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
     * MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
     * ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
     * WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
     * ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
     * OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
     *
     * Feather chevrons (MIT License):
     * Copyright (c) 2013-present Cole Bemis
     * Source: https://github.com/feathericons/feather/blob/master/LICENSE
     * Permission is hereby granted, free of charge, to any person obtaining a
     * copy of this software and associated documentation files (the
     * "Software"), to deal in the Software without restriction, including
     * without limitation the rights to use, copy, modify, merge, publish,
     * distribute, sublicense, and/or sell copies of the Software, and to
     * permit persons to whom the Software is furnished to do so, subject to
     * the following conditions:
     * The above copyright notice and this permission notice shall be included
     * in all copies or substantial portions of the Software.
     * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
     * OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
     * MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
     * IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
     * CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
     * TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
     * SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
     */
    const REPLY_NAV_ICONS = {
        outline: 'M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13',
        pin: [
            'M12 17v5',
            'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
        ],
        'pin-off': [
            'M12 17v5',
            'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89',
            'm2 2 20 20',
            'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11'
        ],
        'previous-reply': 'M12 19V5M5 12l7-7 7 7',
        'next-reply': 'M12 5v14m7-7-7 7-7-7',
        first: 'm17 18-6-6 6-6M7 6v12',
        up: 'm18 15-6-6-6 6',
        down: 'm6 9 6 6 6-6',
        last: 'm7 18 6-6-6-6M17 6v12'
    };
    const RETRYABLE_NATIVE_BINDING_CODES = new Set([
        'DOCUMENT_UNAVAILABLE',
        'WINDOW_UNAVAILABLE',
        'ROUTER_MANIFEST_UNAVAILABLE',
        'CURRENT_ROUTE_UNAVAILABLE',
        'CURRENT_RUNTIME_UNAVAILABLE',
        'SUPPORTED_RUNTIME_NOT_FOUND',
        'NATIVE_MODULE_DISCOVERY_NOT_FOUND',
        'NATIVE_MODULE_SOURCE_UNSUPPORTED',
        'NATIVE_MODULE_EXPORT_SHAPE_UNKNOWN',
        'REACT_FIBERS_UNAVAILABLE',
        'REACT_FIBER_LIMIT_EXCEEDED',
        'ACTIVE_CONVERSATION_NOT_FOUND',
        'AMBIGUOUS_ACTIVE_CONVERSATION',
        'APP_SCOPE_BINDING_UNAVAILABLE',
        'AMBIGUOUS_APP_SCOPE_BINDING',
        'NATIVE_CONVERSATION_STATE_UNAVAILABLE',
        'NATIVE_PAGINATION_UNAVAILABLE'
    ]);
    const RETRYABLE_NATIVE_LOCATOR_CODES = new Set([
        'REACT_FIBERS_UNAVAILABLE',
        'REACT_FIBER_LIMIT_EXCEEDED',
        'ACTIVE_CONVERSATION_NOT_FOUND'
    ]);
    const isRetryableNativeBindingError = error =>
        RETRYABLE_NATIVE_BINDING_CODES.has(error?.code);
    const NATIVE_ADAPTER_RETRY_BASE_MS = 800;
    const NATIVE_ADAPTER_RETRY_MAX_MS = 30_000;
    const MAX_CACHED_CONVERSATIONS = 8;
    const ASSISTANT_UNIT_SELECTOR =
        '[data-content-search-unit-key$=":assistant"], ' +
        '[data-chatgpt-search-unit-key*="assistant"]';
    const USER_MESSAGE_ID_SELECTOR =
        '[data-user-message-bubble="true"][data-chatgpt-search-message-ids], ' +
        '[data-user-message-bubble="true"][data-message-id]';
    const MESSAGE_ELEMENT_SELECTOR =
        '[data-chatgpt-selection-message-id], ' + USER_MESSAGE_ID_SELECTOR;
    const TURN_NODE_SELECTOR =
        '[data-turn-key], [data-content-search-turn-key], ' +
        '[data-user-message-bubble="true"], ' +
        ASSISTANT_UNIT_SELECTOR + ', h4[data-conversation-role="assistant"]';
    const INLINE_USER_EDITOR_SELECTOR =
        'textarea, [contenteditable="true"], [contenteditable=""]';

    let rail = null;
    let barList = null;
    let historyControl = null;
    let preview = null;
    let previewUser = null;
    let previewAssistant = null;
    let replyTopButton = null;
    let replyNavigationUI = null;
    let replyNavigationContext = null;
    let replyOutlineOpen = false;
    let replyOutlineOpenPreference = false;
    let replyOutlinePinned = false;
    let replyOutlineOutsideClickListenerInstalled = false;
    const replyOutlinePinButtonBindings = new WeakSet();
    const replyOutlineToggleClickBindings = new WeakSet();
    const replyOutlineToggleTooltipBindings = new WeakSet();
    let replyLayoutResizeObserver = null;
    let replyLayoutObservedNodes = new Set();
    let replyLayoutObservedSidebar = null;
    let replyOutlineContentShiftState = null;
    let replyOutlineContentShiftFrame = null;
    let assistantReplyNavigationCursor = null;

    let turns = [];
    let turnSignature = '';
    let activeIndex = -1;
    let turnRecordsByChat = new Map();
    let mountedTurnsByIdentity = new Map();
    let activeJumpSearch = null;
    let nativeAdapter = null;
    let nativeLocator = null;
    let historyLoader = null;
    let nativeAdapterError = null;
    let nativeLocatorError = null;
    let adapterConnecting = false;
    let nativeAdapterEpoch = 0;
    let nativeLocatorEpoch = 0;
    let nativeSnapshotTimer = null;
    let latestNativePagination = null;
    let nativeAdapterRetryPending = false;
    let nativeAdapterRetryDelayMs = 0;
    let nextNativeAdapterRetryAt = 0;
    let nativeLocatorRetryPending = false;
    let nativeLocatorRetryDelayMs = 0;
    let nextNativeLocatorRetryAt = 0;
    let lastLocatorDiagnostic = '';
    let lastHistoryCapabilityDiagnostic = '';
    let lastHistoryControlDiagnostic = '';
    let scrollCoordinatorResizeObserver = null;
    let threadResizeObserver = null;
    let threadResizeObservedNodes = new Set();
    let userScrollGeneration = 0;
    let pendingUserScrollAnchor = false;
    let pendingUserScrollAnchorFrame = null;
    let activeHistoryAnchor = null;
    let extendedScrollRange = null;

    let rebuildTimer = null;
    let rebuildMaxWaitTimer = null;
    let rebuildDirty = false;
    let rebuildImmediatePending = false;
    let activeRAF = null;
    let replyNavigationRAF = null;
    let hideTimer = null;

    let currentChatIdentity = null;
    let turnIdentitiesByChat = new Map();
    let chatOwnersByTurnIdentity = new Map();
    let userEditCandidates = new Map();
    let fallbackTurnOwnersByNode = new WeakMap();
    const stableTurnOwnersByNode = new WeakMap();
    let newConversationSubmissionPending = false;
    let newConversationSubmissionTimer = null;
    let contentRefreshTimer = null;
    let pendingContentRefreshes = new Map();
    let mountedStructureFingerprint = null;
    let railDensityCacheKey = '';
    let railLayoutSignature = '';

    function bumpNativeAdapterRetryBackoff() {
        nativeAdapterRetryDelayMs = nativeAdapterRetryDelayMs
            ? Math.min(
                nativeAdapterRetryDelayMs * 2,
                NATIVE_ADAPTER_RETRY_MAX_MS
            )
            : NATIVE_ADAPTER_RETRY_BASE_MS;
        nextNativeAdapterRetryAt = Date.now() + nativeAdapterRetryDelayMs;
    }

    function resetNativeAdapterRetryBackoff() {
        nativeAdapterRetryDelayMs = 0;
        nextNativeAdapterRetryAt = 0;
    }

    function bumpNativeLocatorRetryBackoff() {
        nativeLocatorRetryDelayMs = nativeLocatorRetryDelayMs
            ? Math.min(nativeLocatorRetryDelayMs * 2, NATIVE_ADAPTER_RETRY_MAX_MS)
            : NATIVE_ADAPTER_RETRY_BASE_MS;
        nextNativeLocatorRetryAt = Date.now() + nativeLocatorRetryDelayMs;
    }

    function resetNativeLocatorRetryBackoff() {
        nativeLocatorRetryDelayMs = 0;
        nextNativeLocatorRetryAt = 0;
    }

    function getDiagnosticCode(error, fallback = '') {
        return String(error?.code || fallback).slice(0, 48);
    }

    function reportRouteCapability(name, status, error = null) {
        const code = error ? getDiagnosticCode(error, 'UNKNOWN') : '';
        const key = `${currentChatIdentity}|${name}|${status}|${code}`;
        const previous = name === 'Native message locator'
            ? lastLocatorDiagnostic
            : lastHistoryCapabilityDiagnostic;
        if (previous === key) return;
        if (name === 'Native message locator') lastLocatorDiagnostic = key;
        else lastHistoryCapabilityDiagnostic = key;
        const suffix = code ? ` (${code})` : '';
        console.info(`[Conversation Navigator] ${name} ${status}${suffix}`);
    }

    /******************************************************************
     * CSS
     ******************************************************************/

    function installStyles() {
        if (document.getElementById(STYLE_ID)) return;

        const style = document.createElement('style');
        style.id = STYLE_ID;

        style.textContent = `
            /* =========================
               右侧导航容器
               ========================= */

            #${RAIL_ID} {
                position: fixed;
                right: 14px;
                top: 50%;
                transform: translateY(-50%);

                width: 54px;
                max-height: 72vh;
                --yw-nav-hit-width: 44px;
                --yw-nav-control-size: 32px;
                --yw-nav-history-icon-size: 16px;
                --yw-nav-list-right-inset: 2px;
                --yw-nav-control-glyph-inset: calc(
                    (var(--yw-nav-control-size) -
                        var(--yw-nav-history-icon-size)) / 2
                );

                display: flex;
                flex-direction: column;
                align-items: center;
                gap: 0;

                overflow: visible;
                overflow-x: visible;

                padding: 0;
                margin: 0;
                box-sizing: border-box;

                z-index: 2147483646;

                scrollbar-width: none;
                pointer-events: auto;
            }

            #${RAIL_ID} .yw-nav-toolbar {
                position: absolute;
                right: calc(
                    var(--yw-nav-list-right-inset) -
                    var(--yw-nav-control-glyph-inset)
                );
                bottom: calc(100% + 8px);
                display: flex;
                flex: 0 0 auto;
                width: var(--yw-nav-control-size);
                height: var(--yw-nav-control-size);
                justify-content: center;
                padding: 0;
                box-sizing: border-box;
            }

            #${RAIL_ID} .yw-nav-toolbar[hidden] {
                display: none !important;
            }

            #${RAIL_ID} .yw-turn-list {
                position: relative;
                display: flex;
                flex: 0 1 auto;
                flex-direction: column;
                align-items: flex-end;
                gap: var(--yw-nav-gap, 8px);
                width: 100%;
                max-height: 72vh;
                overflow-y: auto;
                overflow-x: visible;
                padding: 8px var(--yw-nav-list-right-inset) 8px 8px;
                box-sizing: border-box;
                scrollbar-width: none;
            }

            #${RAIL_ID} .yw-turn-list::-webkit-scrollbar {
                display: none;
            }

            #${RAIL_ID} .yw-history-control,
            .yw-reply-top {
                appearance: none;
                -webkit-appearance: none;
                display: grid;
                flex: 0 0 var(--yw-nav-control-size, 32px);
                place-items: center;
                width: var(--yw-nav-control-size, 32px);
                height: var(--yw-nav-control-size, 32px);
                padding: 0;
                box-sizing: border-box;
                border-radius: 50%;
                cursor: pointer;
                outline: none;
            }

            #${RAIL_ID} .yw-history-control {
                border: 0;
                background: transparent;
                color: #8F8F8F;
                box-shadow: none;
                transition: background-color 120ms ease, opacity 120ms ease;
            }

            #${RAIL_ID} .yw-history-control:hover,
            #${RAIL_ID} .yw-history-control:focus-visible {
                background: #EFEFEF;
                border-radius: 6px;
            }

            #${RAIL_ID} .yw-history-control:disabled {
                opacity: 0.55;
                cursor: default;
            }

            #${RAIL_ID} .yw-history-control svg {
                width: var(--yw-nav-history-icon-size);
                height: var(--yw-nav-history-icon-size);
            }

            #${RAIL_ID} .yw-history-control svg,
            .yw-reply-top svg {
                display: block;
                fill: none;
                stroke: currentColor;
                stroke-width: 1.8;
                stroke-linecap: round;
                stroke-linejoin: round;
            }

            #${RAIL_ID} .yw-history-tooltip {
                position: absolute;
                right: calc(100% + 8px);
                top: 0;
                display: flex;
                align-items: center;
                width: max-content;
                max-width: calc(100vw - 80px);
                height: var(--yw-nav-control-size, 32px);
                padding: 0 16px;
                margin: 0;
                box-sizing: border-box;
                border: 0;
                border-radius: 999px;
                background: #0D0D0D;
                color: #FFFFFF;
                font-size: 14px;
                line-height: 1.5;
                font-weight: 700;
                white-space: nowrap;
                box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
                opacity: 0;
                visibility: hidden;
                transform: translateX(4px);
                transition: opacity 100ms ease, transform 100ms ease,
                    visibility 100ms ease;
                pointer-events: none;
            }

            #${RAIL_ID} .yw-history-tooltip-text {
                min-width: 0;
                overflow: hidden;
                text-overflow: ellipsis;
            }

            #${RAIL_ID} .yw-history-tooltip-detail {
                font-weight: 400;
            }

            #${RAIL_ID} .yw-nav-toolbar:hover .yw-history-tooltip,
            #${RAIL_ID} .yw-history-control:focus-visible ~ .yw-history-tooltip {
                opacity: 1;
                visibility: visible;
                transform: translateX(0);
            }

            .yw-reply-top {
                position: fixed;
                z-index: 2147483645;
                transform: translateX(-50%);
                border: 1px solid var(--color-border, rgba(127, 127, 127, 0.35));
                background: var(--color-surface, rgba(255, 255, 255, 0.94));
                background-clip: padding-box;
                color: var(--color-text-secondary, #555);
                box-shadow: none;
                transition: opacity var(--transition-duration-basic, 120ms) ease-in-out;
            }

            .yw-reply-top svg {
                width: 20px;
                height: 20px;
            }

            #${RAIL_ID} .yw-history-control.yw-history-loading svg {
                animation: yw-history-spin 900ms linear infinite;
            }

            @keyframes yw-history-spin {
                to { transform: rotate(-360deg); }
            }

            .yw-reply-top[hidden] {
                display: none !important;
            }

            #${REPLY_NAV_ID} {
                position: fixed;
                inset: 0;
                z-index: 2147483646;
                pointer-events: none;
            }

            #${REPLY_NAV_ID}[hidden] {
                display: none !important;
            }

            #${REPLY_NAV_ID} .yw-reply-toolbar {
                position: fixed;
                display: flex;
                flex-direction: column;
                gap: 2px;
                width: 32px;
                padding: 0;
                margin: 0;
                box-sizing: border-box;
                z-index: 1;
                pointer-events: auto;
            }

            #${REPLY_NAV_ID} .yw-reply-toolbar[hidden] {
                display: none !important;
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button {
                appearance: none;
                -webkit-appearance: none;
                display: grid;
                flex: 0 0 32px;
                place-items: center;
                width: 32px;
                height: 32px;
                padding: 0;
                box-sizing: border-box;
                border: 1px solid transparent;
                border-radius: 7px;
                position: relative;
                background: transparent;
                color: var(--text-secondary, var(--color-text-secondary, #8F8F8F));
                cursor: pointer;
                outline: none;
                transition: background-color 120ms ease, color 120ms ease;
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button:hover,
            #${REPLY_NAV_ID} .yw-reply-nav-button[aria-expanded="true"] {
                border-color: transparent;
                background: #EFEFEF;
                color: var(--text-primary, var(--color-text-primary, #555));
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button:focus-visible {
                border-color: transparent;
                background: #EFEFEF;
                color: var(--text-primary, var(--color-text-primary, #555));
                outline: 2px solid currentColor;
                outline-offset: 2px;
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button::after {
                content: attr(aria-label);
                position: absolute;
                z-index: 2;
                left: calc(100% + ${REPLY_NAV_TOOLTIP_GAP}px);
                top: 50%;
                width: max-content;
                max-width: calc(100vw - 80px);
                padding-block: var(--tooltip-padding-block, 5px);
                padding-inline: var(--tooltip-padding-inline, 12px);
                box-sizing: border-box;
                border: 1px solid var(--tooltip-border-color, color-mix(in oklab, #FFFFFF 5%, transparent));
                border-radius: var(--tooltip-border-radius, 16px);
                background: var(--tooltip-background-color, #0D0D0D);
                color: var(--tooltip-text-color, #FFFFFF);
                font-size: var(--tooltip-font-size, 14px);
                font-weight: var(--tooltip-font-weight, 600);
                letter-spacing: var(--tooltip-letter-spacing, -0.15px);
                line-height: var(--tooltip-line-height, 18px);
                white-space: nowrap;
                box-shadow: var(--tooltip-box-shadow, 0 8px 18px #0F172A33);
                opacity: 0;
                visibility: hidden;
                transform: translate(4px, -50%);
                transition: opacity 100ms ease, transform 100ms ease,
                    visibility 100ms ease;
                pointer-events: none;
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button:hover::after,
            #${REPLY_NAV_ID} .yw-reply-nav-button:focus-visible::after {
                opacity: 1;
                visibility: visible;
                transform: translate(0, -50%);
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button:disabled {
                opacity: 0.4;
                cursor: default;
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button:disabled:hover {
                border-color: transparent;
                background: transparent;
                color: var(--text-secondary, var(--color-text-secondary, #8F8F8F));
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button svg {
                display: block;
                width: 18px;
                height: 18px;
                fill: none;
                stroke: currentColor;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
            }

            #${REPLY_NAV_ID} .yw-reply-nav-button[data-action="first"] svg,
            #${REPLY_NAV_ID} .yw-reply-nav-button[data-action="last"] svg {
                transform: rotate(90deg);
            }

            #${REPLY_NAV_ID}-outline-toggle {
                appearance: none;
                -webkit-appearance: none;
                position: fixed;
                z-index: 2;
                pointer-events: auto;
                display: grid !important;
                place-items: center;
                width: ${REPLY_NAV_CONTROL_SIZE}px;
                min-width: ${REPLY_NAV_CONTROL_SIZE}px;
                height: ${REPLY_NAV_CONTROL_SIZE}px;
                min-height: ${REPLY_NAV_CONTROL_SIZE}px;
                padding: 0;
                box-sizing: border-box;
                border: 0;
                border-radius: 8px;
                background: transparent;
                color: var(--color-text-primary, #0D0D0D);
                font: inherit;
                cursor: pointer;
            }

            #${REPLY_NAV_ID}-outline-toggle[aria-expanded="true"] {
                background: color-mix(in oklab, var(--color-text-primary, #0D0D0D) 3%, transparent);
            }

            #${REPLY_NAV_ID}-outline-toggle:hover {
                background: var(--color-background-primary-ghost-hover, color-mix(in oklab, var(--color-text-primary, #0D0D0D) 5%, transparent));
            }

            #${REPLY_NAV_ID}-outline-toggle:active {
                background: var(--color-background-primary-ghost-active, color-mix(in oklab, var(--color-text-primary, #0D0D0D) 12%, transparent));
            }

            #${REPLY_NAV_ID}-outline-toggle:focus-visible {
                outline: 2px solid var(--color-ring-primary-ghost, #3B82F6);
                outline-offset: -1px;
            }

            #${REPLY_NAV_ID}-outline-toggle[hidden] {
                display: none !important;
            }

            .yw-reply-outline-icon {
                display: block;
                flex: 0 0 auto;
                width: 18px;
                height: 18px;
                fill: none;
                stroke: currentColor;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-tooltip {
                position: fixed;
                z-index: 4;
                width: max-content;
                max-width: calc(100vw - 16px);
                padding-block: var(--tooltip-padding-block, 5px);
                padding-inline: var(--tooltip-padding-inline, 12px);
                box-sizing: border-box;
                border: 1px solid var(--tooltip-border-color, color-mix(in oklab, #FFFFFF 5%, transparent));
                border-radius: var(--tooltip-border-radius, 16px);
                background: var(--tooltip-background-color, #0D0D0D);
                color: var(--tooltip-text-color, #FFFFFF);
                font-size: var(--tooltip-font-size, 14px);
                font-weight: var(--tooltip-font-weight, 600);
                letter-spacing: var(--tooltip-letter-spacing, -0.15px);
                line-height: var(--tooltip-line-height, 18px);
                white-space: nowrap;
                box-shadow: var(--tooltip-box-shadow, 0 8px 18px #0F172A33);
                opacity: 0;
                visibility: hidden;
                transform: translateY(-2px);
                transition: opacity 100ms ease, transform 100ms ease,
                    visibility 100ms ease;
                pointer-events: none;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-tooltip[data-visible="true"] {
                opacity: 1;
                visibility: visible;
                transform: translateY(0);
            }

            #${REPLY_NAV_ID} .yw-reply-outline {
                position: fixed;
                z-index: 3;
                display: flex;
                flex-direction: column;
                overflow: hidden;
                width: min(300px, calc(100vw - 16px));
                max-height: min(70vh, 560px);
                min-height: 0;
                padding: 0;
                box-sizing: border-box;
                border: 1px solid var(--color-border, rgba(127, 127, 127, 0.28));
                border-radius: 12px;
                background: var(--main-surface-primary, var(--color-surface, rgba(255, 255, 255, 0.98)));
                color: var(--text-primary, var(--color-text-primary, #222));
                box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
                pointer-events: auto;
            }

            #${REPLY_NAV_ID} .yw-reply-outline[hidden] {
                display: none !important;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-heading-row {
                display: flex;
                flex: 0 0 auto;
                align-items: center;
                justify-content: space-between;
                gap: 8px;
                min-width: 0;
                padding: 10px 12px 8px;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-heading-row h2 {
                min-width: 0;
                margin: 0;
                color: var(--color-text-secondary, #5D5D5D);
                font-size: 14px;
                font-weight: 400;
                line-height: 20px;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-pin-button {
                appearance: none;
                -webkit-appearance: none;
                display: grid;
                flex: 0 0 28px;
                place-items: center;
                width: 28px;
                height: 28px;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 6px;
                background: transparent;
                color: #9CA3AF;
                cursor: pointer;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-pin-button[aria-pressed="true"] {
                color: #5D83EF;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-pin-button:hover {
                background: color-mix(in oklab, var(--color-text-primary, #0D0D0D) 5%, transparent);
            }

            #${REPLY_NAV_ID} .yw-reply-outline-pin-button:focus-visible {
                outline: 2px solid var(--color-ring-primary-ghost, #3B82F6);
                outline-offset: -1px;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-pin-button svg {
                display: block;
                width: 16px;
                height: 16px;
                fill: none;
                stroke: currentColor;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-reply-nav {
                display: flex;
                flex: 0 0 auto;
                align-items: center;
                gap: 2px;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-reply-button {
                appearance: none;
                -webkit-appearance: none;
                display: grid;
                flex: 0 0 28px;
                place-items: center;
                width: 28px;
                height: 28px;
                padding: 0;
                border: 1px solid transparent;
                border-radius: 6px;
                background: transparent;
                color: var(--text-secondary, var(--color-text-secondary, #8F8F8F));
                cursor: pointer;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-reply-button:hover,
            #${REPLY_NAV_ID} .yw-reply-outline-reply-button:focus-visible {
                border-color: transparent;
                background: var(--background-modifier-hover, rgba(127, 127, 127, 0.12));
                color: var(--text-primary, var(--color-text-primary, #555));
                outline: none;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-reply-button:disabled {
                opacity: 0.4;
                cursor: default;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-reply-button svg {
                display: block;
                width: 16px;
                height: 16px;
                fill: none;
                stroke: currentColor;
                stroke-width: 2;
                stroke-linecap: round;
                stroke-linejoin: round;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-list {
                display: flex;
                flex: 1 1 auto;
                flex-direction: column;
                gap: 1px;
                min-height: 0;
                overflow-y: auto;
                overflow-x: hidden;
                padding: 0 12px 12px;
                margin: 0;
                list-style: none;
                scrollbar-width: thin;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-item {
                min-width: 0;
                padding: 0;
                margin: 0;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-target {
                display: block;
                width: 100%;
                padding: 4px 6px;
                box-sizing: border-box;
                border: 0;
                border-radius: 6px;
                background: transparent;
                color: var(--color-text-primary, #0D0D0D);
                font: inherit;
                font-size: 14px;
                font-weight: 400;
                line-height: 20px;
                text-align: left;
                white-space: normal;
                overflow-wrap: anywhere;
                cursor: pointer;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-target:hover,
            #${REPLY_NAV_ID} .yw-reply-outline-target:focus-visible {
                background: var(--background-modifier-hover, rgba(127, 127, 127, 0.12));
                outline: none;
            }

            #${REPLY_NAV_ID} .yw-reply-outline-empty {
                padding: 3px 6px;
                color: var(--text-secondary, var(--color-text-secondary, #8F8F8F));
                font-size: 13px;
                line-height: 1.4;
            }

            /* 单根短横线 */
            #${RAIL_ID} .yw-turn-bar {
                appearance: none;
                -webkit-appearance: none;

                display: block;
                flex: 0 0 auto;
                position: relative;
                overflow: visible;
                box-sizing: border-box;

                width: 16px;
                height: var(--yw-nav-bar-height, 4px);
                min-height: 0;

                margin: 0 0 0 auto;
                padding: 0;

                border: 0;
                border-radius: 999px;

                background: #D6D6D6;
                transform: translateY(var(--yw-nav-bar-offset, 0px));

                cursor: pointer;

                transition:
                    width 120ms ease,
                    background-color 120ms ease,
                    opacity 120ms ease;

                outline: none;
            }

            #${RAIL_ID} .yw-turn-bar::before {
                content: '';
                position: absolute;
                top: 50%;
                right: 0;
                width: var(--yw-nav-hit-width, 44px);
                height: calc(100% + var(--yw-nav-gap, 8px));
                transform: translateY(-50%);
                pointer-events: auto;
            }

            /* hover：向左伸长 */
            #${RAIL_ID} .yw-turn-bar:hover,
            #${RAIL_ID} .yw-turn-bar:focus-visible {
                width: 29px;
                background: color-mix(
                    in srgb,
                    var(--text-primary, #111) 68%,
                    transparent
                );
            }

            /* 当前正在看的这一轮 */
            #${RAIL_ID} .yw-turn-bar.yw-active {
                width: 36px;
                background: var(--text-primary, #111);
            }

            /* 当前条 hover 时再略微强调 */
            #${RAIL_ID} .yw-turn-bar.yw-active:hover {
                width: 38px;
            }


            /* =========================
               Hover 预览卡片
               ========================= */

            #${PREVIEW_ID} {
                position: fixed;

                /*
                 * rail 在最右侧，因此 tooltip 出现在它左边
                 */
                right: 66px;
                top: 50%;

                width: min(440px, calc(100vw - 110px));
                max-height: min(390px, 70vh);

                box-sizing: border-box;

                padding: 16px 18px 17px;

                border-radius: 18px;

                background:
                    var(
                        --main-surface-primary,
                        var(--color-surface, rgba(255, 255, 255, 0.97))
                    );

                color: var(--text-primary, var(--color-text-primary, #171717));

                border: 1px solid var(
                    --color-border,
                    color-mix(
                        in srgb,
                        var(--text-primary, var(--color-text-primary, #111)) 10%,
                        transparent
                    )
                );

                box-shadow:
                    0 10px 35px rgba(0, 0, 0, 0.10),
                    0 2px 8px rgba(0, 0, 0, 0.04);

                backdrop-filter: blur(18px);
                -webkit-backdrop-filter: blur(18px);

                opacity: 0;
                visibility: hidden;

                transform: translateX(5px);
                transition:
                    opacity 100ms ease,
                    transform 100ms ease,
                    visibility 100ms ease;

                z-index: 2147483647;

                /*
                 * 这是预览，不让卡片本身抢鼠标，
                 * hover 状态完全由右侧 bar 控制。
                 */
                pointer-events: none;
            }

            #${PREVIEW_ID}.yw-visible {
                opacity: 1;
                visibility: visible;
                transform: translateX(0);
            }

            /* 用户消息：对应截图中的粗体标题 */
            #${PREVIEW_ID} .yw-preview-user {
                margin: 0;

                font-family:
                    -apple-system,
                    BlinkMacSystemFont,
                    "Segoe UI",
                    "PingFang SC",
                    "Microsoft YaHei",
                    sans-serif;

                font-size: 16px;
                line-height: 1.48;
                font-weight: 600;

                color: var(--text-primary, var(--color-text-primary, #171717));

                white-space: pre-wrap;
                overflow-wrap: anywhere;

                display: -webkit-box;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 3;
                overflow: hidden;
            }

            /* ChatGPT 回复：较浅 */
            #${PREVIEW_ID} .yw-preview-assistant {
                margin-top: 9px;

                font-family:
                    -apple-system,
                    BlinkMacSystemFont,
                    "Segoe UI",
                    "PingFang SC",
                    "Microsoft YaHei",
                    sans-serif;

                font-size: 14.5px;
                line-height: 1.55;
                font-weight: 400;

                color:
                    color-mix(
                        in srgb,
                        var(--text-primary, var(--color-text-primary, #171717)) 62%,
                        transparent
                    );

                white-space: pre-wrap;
                overflow-wrap: anywhere;

                display: -webkit-box;
                -webkit-box-orient: vertical;
                -webkit-line-clamp: 7;
                overflow: hidden;
            }

            #${PREVIEW_ID}.yw-assistant-only .yw-preview-user {
                display: none;
            }

            #${PREVIEW_ID}.yw-assistant-only .yw-preview-assistant {
                margin-top: 0;
            }

            /* 小屏幕稍微靠边一点 */
            @media (max-width: 800px) {
                #${RAIL_ID} {
                    right: 6px;
                    width: 48px;
                    --yw-nav-hit-width: 38px;
                }

                #${PREVIEW_ID} {
                    right: 51px;
                    width: min(380px, calc(100vw - 72px));
                }
            }

            html.chatgpt-theme[data-theme="dark"] #${REPLY_NAV_ID} .yw-reply-outline,
            html.dark #${REPLY_NAV_ID} .yw-reply-outline,
            html.chatgpt-theme[data-theme="dark"] #${PREVIEW_ID},
            html.dark #${PREVIEW_ID} {
                background: #2B2B2B;
            }

            html.chatgpt-theme[data-theme="dark"] #${RAIL_ID} .yw-turn-bar,
            html.dark #${RAIL_ID} .yw-turn-bar {
                background: #666666;
            }

            html.chatgpt-theme[data-theme="dark"] #${RAIL_ID} .yw-turn-bar:hover,
            html.chatgpt-theme[data-theme="dark"] #${RAIL_ID} .yw-turn-bar:focus-visible,
            html.dark #${RAIL_ID} .yw-turn-bar:hover,
            html.dark #${RAIL_ID} .yw-turn-bar:focus-visible {
                background: #AAAAAA;
            }

            html.chatgpt-theme[data-theme="dark"] #${RAIL_ID} .yw-turn-bar.yw-active,
            html.dark #${RAIL_ID} .yw-turn-bar.yw-active {
                background: #EDEDED;
            }
        `;

        (document.head || document.documentElement).appendChild(style);
    }


    /******************************************************************
     * 创建 UI
     ******************************************************************/

    function createReplyNavigationIcon(pathData) {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        for (const pathValue of Array.isArray(pathData) ? pathData : [pathData]) {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', pathValue);
            svg.appendChild(path);
        }
        return svg;
    }

    function updateReplyOutlinePinButton() {
        const button = replyNavigationUI?.outlinePinButton;
        if (!button) return;
        const pinned = Boolean(replyOutlinePinned);
        const icon = pinned ? 'pin' : 'pin-off';
        const label = pinned ? '取消固定大纲' : '固定大纲';
        button.setAttribute('aria-label', label);
        button.setAttribute('aria-pressed', String(pinned));
        button.setAttribute('title', label);
        if (button.dataset.icon !== icon) {
            const svg = createReplyNavigationIcon(REPLY_NAV_ICONS[icon]);
            svg.setAttribute('class', 'yw-reply-outline-icon');
            button.replaceChildren(svg);
            button.dataset.icon = icon;
        }
    }

    function readReplyOutlinePinnedPreference() {
        try {
            return window.localStorage.getItem(
                REPLY_OUTLINE_PINNED_STORAGE_KEY
            ) === 'true';
        } catch (_) {
            return false;
        }
    }

    function persistReplyOutlinePinnedPreference() {
        try {
            window.localStorage.setItem(
                REPLY_OUTLINE_PINNED_STORAGE_KEY,
                replyOutlinePinned ? 'true' : 'false'
            );
        } catch (_) {
            // The in-memory preference remains usable when storage is blocked.
        }
    }

    function readReplyOutlineOpenPreference() {
        try {
            return window.localStorage.getItem(
                REPLY_OUTLINE_OPEN_STORAGE_KEY
            ) === 'true';
        } catch (_) {
            return false;
        }
    }

    function persistReplyOutlineOpenPreference() {
        try {
            window.localStorage.setItem(
                REPLY_OUTLINE_OPEN_STORAGE_KEY,
                replyOutlineOpenPreference ? 'true' : 'false'
            );
        } catch (_) {
            // The in-memory preference remains usable when storage is blocked.
        }
    }

    function initializeReplyOutlinePreferences() {
        replyOutlinePinned = readReplyOutlinePinnedPreference();
        replyOutlineOpenPreference = readReplyOutlineOpenPreference();
        replyOutlineOpen = replyOutlinePinned && replyOutlineOpenPreference;
        updateReplyOutlinePinButton();
    }

    function bindReplyOutlinePinButton(button) {
        if (!button || replyOutlinePinButtonBindings.has(button)) return;
        replyOutlinePinButtonBindings.add(button);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            replyOutlinePinned = !replyOutlinePinned;
            persistReplyOutlinePinnedPreference();
            updateReplyOutlinePinButton();
        });
    }

    function bindReplyOutlineToggleClickHandler(button) {
        if (!button || replyOutlineToggleClickBindings.has(button)) return;
        replyOutlineToggleClickBindings.add(button);
        button.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            toggleReplyOutline();
        });
    }

    function syncReplyOutlineToggleTooltip() {
        const toggle = replyNavigationUI?.outlineToggle;
        if (
            !replyOutlineOpen &&
            (
                toggle?.matches?.(':hover') ||
                toggle?.matches?.(':focus-visible')
            )
        ) {
            showReplyOutlineTooltip();
        } else {
            hideReplyOutlineTooltip();
        }
    }

    function bindReplyOutlineToggleTooltipEvents(button) {
        if (!button || replyOutlineToggleTooltipBindings.has(button)) return;
        replyOutlineToggleTooltipBindings.add(button);
        for (const type of ['pointerenter', 'pointerleave', 'focus', 'blur']) {
            button.addEventListener(type, syncReplyOutlineToggleTooltip);
        }
    }

    function handleReplyOutlineOutsideClick(event) {
        const ui = replyNavigationUI;
        const target = event?.target;
        if (
            !ui || !replyOutlineOpen || replyOutlinePinned || !target ||
            ui.outline.contains(target) || ui.outlineToggle.contains(target)
        ) {
            return;
        }
        setReplyOutlineOpen(false);
    }

    function registerReplyOutlineOutsideClickHandling() {
        if (replyOutlineOutsideClickListenerInstalled) return;
        document.addEventListener('click', handleReplyOutlineOutsideClick, true);
        replyOutlineOutsideClickListenerInstalled = true;
    }

    function ensureReplyNavigationUI() {
        registerReplyOutlineOutsideClickHandling();
        if (replyNavigationUI?.root?.isConnected) {
            updateReplyOutlineToggleLabel();
            updateReplyOutlinePinButton();
            return;
        }

        document.getElementById(REPLY_NAV_ID)?.remove();
        const root = document.createElement('div');
        root.id = REPLY_NAV_ID;
        root.hidden = true;

        const toolbar = document.createElement('div');
        toolbar.className = 'yw-reply-toolbar';
        toolbar.setAttribute('role', 'group');
        toolbar.setAttribute('aria-label', '当前回复导航');

        const buttonSpecs = [
            ['previous-reply', '上一个助手回复'],
            ['first', '回到当前回复顶部'],
            ['up', '上一个标题'],
            ['down', '下一个标题'],
            ['last', '跳到当前回复底部'],
            ['next-reply', '下一个助手回复']
        ];
        const buttons = new Map();
        for (const [action, label] of buttonSpecs) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'yw-reply-nav-button';
            button.dataset.action = action;
            button.setAttribute('aria-label', label);
            button.appendChild(createReplyNavigationIcon(REPLY_NAV_ICONS[action]));
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                if (action === 'previous-reply') navigateAssistantReply('previous');
                else if (action === 'first') jumpToCurrentReplyTop();
                else if (action === 'up') navigateReplyHeading('up');
                else if (action === 'down') navigateReplyHeading('down');
                else if (action === 'last') jumpToCurrentReplyBottom();
                else if (action === 'next-reply') navigateAssistantReply('next');
            });
            buttons.set(action, button);
            toolbar.appendChild(button);
        }

        const outlineToggle = document.createElement('button');
        outlineToggle.type = 'button';
        outlineToggle.id = `${REPLY_NAV_ID}-outline-toggle`;
        outlineToggle.className = 'yw-reply-outline-toggle';
        outlineToggle.hidden = true;
        outlineToggle.setAttribute('aria-label', '当前回复大纲');
        outlineToggle.setAttribute('aria-expanded', 'false');
        outlineToggle.setAttribute('aria-controls', `${REPLY_NAV_ID}-outline`);
        const outlineIcon = createReplyNavigationIcon(REPLY_NAV_ICONS.outline);
        outlineIcon.classList.add('yw-reply-outline-icon');
        const outlineTooltip = document.createElement('span');
        outlineTooltip.id = `${REPLY_NAV_ID}-outline-tooltip`;
        outlineTooltip.className = 'yw-reply-outline-tooltip';
        outlineTooltip.setAttribute('aria-hidden', 'true');
        outlineTooltip.textContent = '展开大纲';
        outlineTooltip.dataset.visible = 'false';
        outlineTooltip.hidden = true;
        outlineToggle.appendChild(outlineIcon);
        bindReplyOutlineToggleClickHandler(outlineToggle);
        bindReplyOutlineToggleTooltipEvents(outlineToggle);

        const outline = document.createElement('section');
        outline.id = `${REPLY_NAV_ID}-outline`;
        outline.className = 'yw-reply-outline';
        outline.hidden = true;
        outline.setAttribute('role', 'region');
        outline.setAttribute('aria-labelledby', `${REPLY_NAV_ID}-title`);

        const headingRow = document.createElement('div');
        headingRow.className = 'yw-reply-outline-heading-row';
        const heading = document.createElement('h2');
        heading.id = `${REPLY_NAV_ID}-title`;
        heading.textContent = '当前回复大纲';
        const replyNavigation = document.createElement('div');
        replyNavigation.className = 'yw-reply-outline-reply-nav';
        replyNavigation.setAttribute('role', 'group');
        replyNavigation.setAttribute('aria-label', '助手回复导航');
        const replyButtons = new Map();
        for (const [direction, action, label] of [
            ['previous', 'previous-reply', '上一个助手回复'],
            ['next', 'next-reply', '下一个助手回复']
        ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'yw-reply-outline-reply-button';
            button.dataset.direction = direction;
            button.setAttribute('aria-label', label);
            button.appendChild(createReplyNavigationIcon(REPLY_NAV_ICONS[action]));
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                navigateAssistantReply(direction);
            });
            replyButtons.set(direction, button);
            replyNavigation.appendChild(button);
        }

        const outlinePinButton = document.createElement('button');
        outlinePinButton.type = 'button';
        outlinePinButton.className = 'yw-reply-outline-pin-button';
        bindReplyOutlinePinButton(outlinePinButton);
        headingRow.append(outlinePinButton, heading, replyNavigation);
        outline.appendChild(headingRow);

        const list = document.createElement('ol');
        list.className = 'yw-reply-outline-list';
        outline.appendChild(list);

        root.append(toolbar, outlineToggle, outline, outlineTooltip);
        document.body.appendChild(root);
        replyNavigationUI = {
            root,
            toolbar,
            outline,
            outlineToggle,
            outlinePinButton,
            outlineTooltip,
            heading,
            replyButtons,
            list,
            buttons
        };
        updateReplyOutlineToggleLabel();
        updateReplyOutlinePinButton();
        syncReplyOutlineToggleBinding();
    }

    function getReplySidebarElement() {
        return document.querySelector('aside.app-shell-left-panel');
    }

    function getReplySidebarGeometry(element = getReplySidebarElement()) {
        if (
            !element?.isConnected || element.hidden ||
            element.getAttribute('aria-hidden') === 'true'
        ) {
            return null;
        }
        const style = window.getComputedStyle(element);
        if (
            style.display === 'none' || style.visibility === 'hidden' ||
            Number(style.opacity) === 0
        ) {
            return null;
        }
        const rect = element.getBoundingClientRect();
        if (
            rect.width <= 0 || rect.height <= 0 ||
            rect.right <= 0 || rect.left >= window.innerWidth
        ) {
            return null;
        }
        return {left: rect.left, right: rect.right};
    }

    function syncReplyOutlineToggleBinding() {
        const ui = replyNavigationUI;
        if (!ui?.outlineToggle) return;
        const toggle = ui.outlineToggle;
        const hasReply = Boolean(replyNavigationContext?.reply?.isConnected);
        const toolbarAvailable = Boolean(
            hasReply && !ui.root.hidden && !ui.toolbar.hidden
        );
        const keepOpenWithoutReply = Boolean(
            !hasReply && replyOutlineOpen && !ui.root.hidden
        );
        toggle.hidden = !(toolbarAvailable || keepOpenWithoutReply);
        if (toggle.hidden || !toggle.isConnected) hideReplyOutlineTooltip();
        const expanded = String(Boolean(
            replyOutlineOpen && !ui.root.hidden && !ui.outline.hidden
        ));
        if (toggle.getAttribute('aria-expanded') !== expanded) {
            toggle.setAttribute('aria-expanded', expanded);
        }
    }

    function isReplyOutlineToggleMutation(mutation) {
        const toggle = replyNavigationUI?.outlineToggle;
        if (!toggle) return false;
        if (toggle === mutation.target || toggle.contains(mutation.target)) {
            return true;
        }
        if (mutation.type !== 'childList') return false;
        const changedNodes = [
            ...Array.from(mutation.addedNodes),
            ...Array.from(mutation.removedNodes)
        ];
        return changedNodes.length > 0 && changedNodes.every(node =>
            node === toggle || toggle.contains(node)
        );
    }

    function isReplySidebarMutation(mutation) {
        const target = asElement(mutation.target);
        if (target?.closest('aside.app-shell-left-panel')) return true;
        if (mutation.type !== 'childList') return false;
        return [
            ...Array.from(mutation.addedNodes),
            ...Array.from(mutation.removedNodes)
        ].some(node => node instanceof Element && (
            node.matches('aside.app-shell-left-panel') ||
            Boolean(node.querySelector('aside.app-shell-left-panel'))
        ));
    }

    function isOwnNavigationMutation(mutation) {
        const target = mutation.target;
        const shiftState = replyOutlineContentShiftState;
        const ownContentShift = Boolean(
            mutation.attributeName === 'style' &&
            shiftState?.element === target &&
            readReplyThreadContentX(target) === shiftState.appliedValue
        );
        return Boolean(
            rail?.contains(target) ||
            preview?.contains(target) ||
            replyTopButton === target ||
            replyTopButton?.contains(target) ||
            isReplyOutlineToggleMutation(mutation) ||
            replyNavigationUI?.root?.contains(target) ||
            ownContentShift
        );
    }

    function ensureUI() {
        installStyles();

        rail = document.getElementById(RAIL_ID);

        if (!rail) {
            rail = document.createElement('div');
            rail.id = RAIL_ID;
            rail.setAttribute('aria-label', 'ChatGPT conversation navigator');
            rail.style.display = 'none';
        }

        if (!historyControl || !rail.contains(historyControl)) {
            let toolbar = rail.querySelector('.yw-nav-toolbar');
            if (!toolbar) {
                toolbar = document.createElement('div');
                toolbar.className = 'yw-nav-toolbar';
                rail.appendChild(toolbar);
            }
            /* Drop controls rendered by an older version of the script. */
            toolbar.replaceChildren();
            historyControl = document.createElement('button');
            historyControl.type = 'button';
            historyControl.className = 'yw-history-control';
            historyControl.setAttribute('aria-live', 'off');
            historyControl.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/></svg>';
            historyControl.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                toggleHistoryLoading();
            });
            toolbar.appendChild(historyControl);

            const status = document.createElement('span');
            status.className = 'yw-history-tooltip';
            status.setAttribute('role', 'tooltip');
            status.setAttribute('aria-live', 'polite');
            status.id = `${RAIL_ID}-status`;
            toolbar.appendChild(status);
            historyControl.setAttribute('aria-describedby', status.id);
        }

        if (!barList || !rail.contains(barList) || barList.parentElement !== rail) {
            /*
             * An updated script can reuse a rail rendered by an older
             * version on a live page. Adopt its single bar list and drop
             * legacy bar/list nodes instead of stacking a second list.
             */
            barList = null;
            for (const child of Array.from(rail.children)) {
                if (!(child instanceof Element)) continue;
                if (
                    child.classList.contains('yw-turn-list') &&
                    !barList
                ) {
                    barList = child;
                    continue;
                }
                if (
                    child.classList.contains('yw-turn-list') ||
                    child.classList.contains('yw-turn-bar')
                ) {
                    child.remove();
                }
            }
        }

        if (!barList) {
            barList = document.createElement('div');
            barList.className = 'yw-turn-list';
            barList.setAttribute('aria-label', 'Conversation turns');
            rail.appendChild(barList);
        }

        if (!rail.isConnected) document.body.appendChild(rail);

        if (!replyTopButton || !replyTopButton.isConnected) {
            for (const stale of document.querySelectorAll('.yw-reply-top')) {
                stale.remove();
            }
            replyTopButton = document.createElement('button');
            replyTopButton.type = 'button';
            replyTopButton.className = 'yw-reply-top';
            replyTopButton.hidden = true;
            replyTopButton.setAttribute('aria-label', '回到当前回复顶部');
            replyTopButton.appendChild(
                createReplyNavigationIcon(REPLY_NAV_ICONS['previous-reply'])
            );
            replyTopButton.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                const identity = replyTopButton.dataset.identity;
                const messageId = replyTopButton.dataset.messageId;
                if (identity) {
                    jumpToIdentity(identity, messageId, { replyTop: true });
                }
            });
            document.body.appendChild(replyTopButton);
        }

        ensureReplyNavigationUI();

        preview = document.getElementById(PREVIEW_ID);

        if (!preview) {
            preview = document.createElement('div');
            preview.id = PREVIEW_ID;

            previewUser = document.createElement('div');
            previewUser.className = 'yw-preview-user';

            previewAssistant = document.createElement('div');
            previewAssistant.className = 'yw-preview-assistant';

            preview.appendChild(previewUser);
            preview.appendChild(previewAssistant);

            document.body.appendChild(preview);
        } else {
            previewUser = preview.querySelector('.yw-preview-user');
            previewAssistant = preview.querySelector('.yw-preview-assistant');
        }
        if (!turns.length) rail.style.display = 'none';
        updateHistoryControl();
    }


    /******************************************************************
     * 跟踪 SPA 中当前对话
     ******************************************************************/

    function getChatIdentity() {
        const pathname = window.location.pathname || '/';
        const conversation = pathname.match(/(?:^|\/)c\/([^/]+)/);

        return conversation
            ? `conversation:${conversation[1]}`
            : `route:${pathname}`;
    }

    function getNativeConversationId(chatIdentity = currentChatIdentity) {
        return chatIdentity?.startsWith('conversation:')
            ? chatIdentity.slice('conversation:'.length)
            : null;
    }

    /*
     * The history control is an action button, not a pagination diagnostic.
     * It only appears when the native state confirms that older pages exist
     * (a cursor) or when an already-started load can be resumed or retried.
     * "Unknown" must never look like "needs loading".
     */
    function deriveHistoryControlView({
        chatOpen,
        turnCount,
        adapterConnecting,
        adapterError,
        loaderState,
        pagination
    }) {
        const state = loaderState || {};
        const complete = pagination?.complete === true;
        const canLoadPrevious = !complete &&
            pagination?.canLoadPrevious === true;
        const cursor = state.cursor ?? pagination?.cursor ?? null;
        const cursorKnown = typeof cursor === 'string' && cursor.length > 0;
        const running = Boolean(state.running);
        const stoppedWithMore = !complete && cursorKnown &&
            state.status === 'stopped';
        const errorWithMore = !complete && cursorKnown &&
            (
                state.status === 'error' ||
                pagination?.hasError === true ||
                Boolean(adapterError)
            );
        const show = Boolean(chatOpen && turnCount > 0 &&
            (running || canLoadPrevious || stoppedWithMore || errorWithMore));
        let reason = 'unknown';
        if (!chatOpen) reason = 'no-conversation';
        else if (running) reason = 'loading';
        else if (errorWithMore) reason = 'retry-available';
        else if (canLoadPrevious || stoppedWithMore) reason = 'older-pages-confirmed';
        else if (pagination?.complete === true || state.status === 'complete') reason = 'complete';
        else if (adapterError) reason = 'unavailable';
        else if (turnCount === 0) reason = 'no-turns';

        const label = '加载全部历史';
        let visibleLabel = label;
        let title = label;
        let disabled = Boolean(adapterConnecting);

        if (running) {
            visibleLabel = '停止加载历史';
            title = '正在加载历史；点击停止';
        } else if (errorWithMore) {
            const error = state.error || adapterError;
            const code = String(error?.code || 'HISTORY_LOAD_FAILED').slice(0, 48);
            visibleLabel = '重试加载历史';
            title = `加载失败（${code}），点击重试。`;
        } else if (!chatOpen) {
            disabled = true;
            title = label;
        } else if (state.status === 'stopped') {
            visibleLabel = '继续加载历史';
            title = '继续加载历史';
        }

        return {
            hidden: !show,
            label: visibleLabel,
            title,
            disabled,
            busy: Boolean(adapterConnecting || state.running),
            reason,
            reasonCode: reason === 'unavailable' || reason === 'retry-available'
                ? String((state.error || adapterError)?.code || 'HISTORY_LOAD_FAILED').slice(0, 48)
                : ''
        };
    }

    function updateHistoryControl() {
        if (!historyControl) return;
        const status = document.getElementById(`${RAIL_ID}-status`);
        const state = historyLoader?.getState();
        const chatOpen = Boolean(getNativeConversationId());
        const view = deriveHistoryControlView({
            chatOpen,
            turnCount: turns.length,
            adapterConnecting,
            adapterError: nativeAdapterError,
            loaderState: state,
            pagination: latestNativePagination
        });

        const diagnosticKey = `${currentChatIdentity}|${view.hidden ? 'hidden' : 'visible'}|${view.reason}|${view.reasonCode}`;
        if (diagnosticKey !== lastHistoryControlDiagnostic) {
            lastHistoryControlDiagnostic = diagnosticKey;
            const visibility = view.hidden ? 'hidden' : 'visible';
            const detail = view.reasonCode ? `: ${view.reasonCode}` : '';
            console.info(`[Conversation Navigator] History control ${visibility} (${view.reason}${detail})`);
        }

        historyControl.hidden = view.hidden;
        const toolbar = rail?.querySelector('.yw-nav-toolbar');
        if (toolbar) toolbar.hidden = historyControl.hidden;
        historyControl.disabled = view.disabled;
        historyControl.classList.toggle('yw-history-loading', Boolean(state?.running));
        historyControl.setAttribute('aria-busy', String(view.busy));
        historyControl.setAttribute('aria-label', view.label);
        historyControl.removeAttribute('title');
        if (status && (!status.firstElementChild || status.textContent !== view.title)) {
            const text = document.createElement('span');
            text.className = 'yw-history-tooltip-text';
            for (const part of view.title.split(/(（[^（）]*）)/u)) {
                if (!part) continue;
                const segment = document.createElement('span');
                if (part.startsWith('（') && part.endsWith('）')) {
                    segment.className = 'yw-history-tooltip-detail';
                }
                segment.textContent = part;
                text.appendChild(segment);
            }
            status.replaceChildren(text);
        }
    }

    function monitorHistoryLoad(operation) {
        console.info('[Conversation Navigator] History load started');
        updateHistoryControl();
        return Promise.resolve(operation).then(state => {
            if (state?.status === 'complete') {
                console.info('[Conversation Navigator] History load complete');
            } else if (state?.status === 'error') {
                console.warn(`[Conversation Navigator] History load failed (${getDiagnosticCode(state.error, 'HISTORY_LOAD_FAILED')})`);
            } else if (state?.status === 'stopped') {
                console.info('[Conversation Navigator] History load stopped');
            }
            return state;
        }).finally(updateHistoryControl);
    }

    function toggleHistoryLoading() {
        if (!historyLoader || nativeAdapterError) {
            const chatIdentity = currentChatIdentity;
            if (!getNativeConversationId(chatIdentity) || adapterConnecting) {
                updateHistoryControl();
                return;
            }
            const reconnect = startNativeAdapter(chatIdentity, { manual: true }).then(() => {
                if (
                    chatIdentity === currentChatIdentity &&
                    historyLoader &&
                    !nativeAdapterError
                ) {
                    return monitorHistoryLoad(historyLoader.start());
                }
                return null;
            });
            Promise.resolve(reconnect).finally(updateHistoryControl);
            updateHistoryControl();
            return;
        }

        const state = historyLoader.getState();
        if (state.running) {
            historyLoader.stop();
            console.info('[Conversation Navigator] History load stop requested');
            updateHistoryControl();
            return;
        }
        monitorHistoryLoad(historyLoader.start());
    }

    function retryNativeAdapterBinding() {
        if (
            !nativeAdapterRetryPending ||
            adapterConnecting ||
            !getNativeConversationId(currentChatIdentity) ||
            Date.now() < nextNativeAdapterRetryAt
        ) {
            return;
        }
        if (nativeAdapter && historyLoader) {
            nativeAdapterRetryPending = false;
            scheduleNativeSnapshotRefresh();
            return;
        }
        if (nativeAdapter || historyLoader) return;
        startNativeAdapter(currentChatIdentity, { automaticRetry: true });
    }

    function disposeRouteNativeLocator(preserveRetryBackoff = false) {
        nativeLocatorEpoch += 1;
        const locator = nativeLocator;
        nativeLocator = null;
        nativeLocatorError = null;
        nativeLocatorRetryPending = false;
        if (!preserveRetryBackoff) resetNativeLocatorRetryBackoff();
        try {
            locator?.dispose?.();
        } catch (_error) {
            /* A stale locator cannot be used after this route generation. */
        }
    }

    function startNativeLocator(chatIdentity, options = {}) {
        disposeRouteNativeLocator(Boolean(options.automaticRetry));
        const epoch = nativeLocatorEpoch;
        const chatId = getNativeConversationId(chatIdentity);
        if (!chatId) {
            reportRouteCapability('Native message locator', 'unavailable', {
                code: 'NO_CONVERSATION'
            });
            return;
        }

        try {
            const locator = createNativeLocator({
                window,
                document,
                chatId,
                isCurrent: () =>
                    epoch === nativeLocatorEpoch &&
                    chatIdentity === currentChatIdentity &&
                    getChatIdentity() === chatIdentity
            });
            if (
                epoch !== nativeLocatorEpoch ||
                chatIdentity !== currentChatIdentity ||
                getChatIdentity() !== chatIdentity
            ) {
                locator.dispose?.();
                return;
            }
            nativeLocator = locator;
            nativeLocatorError = null;
            nativeLocatorRetryPending = false;
            resetNativeLocatorRetryBackoff();
            reportRouteCapability('Native message locator', 'ready');
        } catch (error) {
            if (epoch !== nativeLocatorEpoch || chatIdentity !== currentChatIdentity) return;
            nativeLocatorError = error;
            nativeLocatorRetryPending = !options.manual &&
                RETRYABLE_NATIVE_LOCATOR_CODES.has(error?.code);
            if (nativeLocatorRetryPending) bumpNativeLocatorRetryBackoff();
            reportRouteCapability('Native message locator', 'unavailable', error);
        }
    }

    function retryNativeLocatorBinding() {
        if (
            !nativeLocatorRetryPending ||
            nativeLocator ||
            !getNativeConversationId(currentChatIdentity) ||
            Date.now() < nextNativeLocatorRetryAt
        ) {
            return;
        }
        startNativeLocator(currentChatIdentity, {automaticRetry: true});
    }

    function disposeRouteAdapter() {
        nativeAdapterEpoch += 1;
        clearTimeout(nativeSnapshotTimer);
        if (pendingUserScrollAnchorFrame !== null) {
            cancelAnimationFrame(pendingUserScrollAnchorFrame);
            pendingUserScrollAnchorFrame = null;
        }
        pendingUserScrollAnchor = false;
        activeHistoryAnchor = null;
        nativeSnapshotTimer = null;
        historyLoader?.stop();
        historyLoader = null;
        const adapter = nativeAdapter;
        nativeAdapter = null;
        nativeAdapterError = null;
        adapterConnecting = false;
        nativeAdapterRetryPending = false;
        latestNativePagination = null;
        try {
            adapter?.dispose?.();
        } catch (error) {
            console.warn(`[Conversation Navigator] Adapter cleanup failed (${getDiagnosticCode(error, 'ADAPTER_CLEANUP_FAILED')})`);
        }
        if (threadResizeObserver) {
            threadResizeObserver.disconnect();
            threadResizeObserver = null;
        }
        threadResizeObservedNodes.clear();
        updateHistoryControl();
    }

    async function startNativeAdapter(chatIdentity, options = {}) {
        const manual = Boolean(options.manual);
        disposeRouteAdapter();
        if (manual) {
            nativeAdapterRetryPending = false;
            resetNativeAdapterRetryBackoff();
        }
        const epoch = nativeAdapterEpoch;
        const chatId = getNativeConversationId(chatIdentity);
        if (!chatId) {
            updateHistoryControl();
            return;
        }

        adapterConnecting = true;
        updateHistoryControl();
        try {
            const adapter = await createNativeAdapter({
                window,
                document,
                chatId
            });
            if (
                epoch !== nativeAdapterEpoch ||
                chatIdentity !== currentChatIdentity ||
                getChatIdentity() !== chatIdentity
            ) {
                adapter?.dispose?.();
                return;
            }
            if (
                !adapter ||
                typeof adapter.readSnapshot !== 'function' ||
                typeof adapter.loadPreviousPage !== 'function'
            ) {
                throw new Error('The native history adapter is unsupported.');
            }

            nativeAdapter = adapter;
            const snapshot = await adapter.readSnapshot();
            if (
                epoch !== nativeAdapterEpoch ||
                adapter !== nativeAdapter ||
                chatIdentity !== currentChatIdentity ||
                getChatIdentity() !== chatIdentity
            ) {
                adapter.dispose?.();
                return;
            }

            acceptNativeSnapshot(snapshot, chatIdentity);
            historyLoader = createHistoryLoader({
                readSnapshot: () => adapter.readSnapshot(),
                loadPreviousPage: () => adapter.loadPreviousPage(),
                getChatIdentity: () =>
                    epoch === nativeAdapterEpoch &&
                    chatIdentity === currentChatIdentity &&
                    getChatIdentity() === chatIdentity
                        ? chatIdentity
                        : 'stale:' + String(currentChatIdentity),
                onSnapshot: nextSnapshot => {
                    if (
                        epoch === nativeAdapterEpoch &&
                        adapter === nativeAdapter
                    ) {
                        acceptNativeSnapshot(nextSnapshot, chatIdentity);
                    }
                },
                getAnchor: () => {
                    activeHistoryAnchor = getVisibleReadingAnchor();
                    return activeHistoryAnchor;
                },
                compensateAnchor: async (anchor, snapshot) => {
                    try {
                        return await restoreReadingAnchor(anchor, snapshot);
                    } finally {
                        if (activeHistoryAnchor === anchor) {
                            activeHistoryAnchor = null;
                        }
                    }
                }
            });
            nativeAdapterError = null;
            adapterConnecting = false;
            reportRouteCapability('Native history', 'ready');
            updateHistoryControl();
        } catch (error) {
            if (
                epoch === nativeAdapterEpoch &&
                chatIdentity === currentChatIdentity
            ) {
                adapterConnecting = false;
                nativeAdapterRetryPending = !manual &&
                    isRetryableNativeBindingError(error);
                nativeAdapterError = error;
                if (nativeAdapterRetryPending) bumpNativeAdapterRetryBackoff();
                else resetNativeAdapterRetryBackoff();
                try {
                    nativeAdapter?.dispose?.();
                } catch (_) {}
                nativeAdapter = null;
                historyLoader = null;
                reportRouteCapability('Native history', 'unavailable', error);
                updateHistoryControl();
            }
        }
    }

    function rememberTurnIdentity(chatIdentity, turnIdentity) {
        if (!chatIdentity || !turnIdentity) return;
        getTurnRecordStore(chatIdentity);

        if (!turnIdentitiesByChat.has(chatIdentity)) {
            turnIdentitiesByChat.set(chatIdentity, new Set());
        }
        turnIdentitiesByChat.get(chatIdentity).add(turnIdentity);

        if (!chatOwnersByTurnIdentity.has(turnIdentity)) {
            chatOwnersByTurnIdentity.set(turnIdentity, new Set());
        }
        chatOwnersByTurnIdentity.get(turnIdentity).add(chatIdentity);
    }

    function turnBelongsToAnotherChat(turnIdentity, chatIdentity) {
        const owners = chatOwnersByTurnIdentity.get(turnIdentity);

        return Boolean(owners?.size && !owners.has(chatIdentity));
    }

    function hasForeignFallbackOwner(turn, chatIdentity) {
        const fallbackNodes = [turn.root, turn.userBubble].filter(node =>
            node instanceof Element
        );
        return fallbackNodes.some(node => {
            const owner = fallbackTurnOwnersByNode.get(node);
            const stableOwner = stableTurnOwnersByNode.get(node);
            return (owner && owner !== chatIdentity) ||
                (turn.stableIdentity && stableOwner?.identity === turn.identity &&
                    stableOwner.owner.chatIdentity !== chatIdentity);
        });
    }

    function trackCurrentRouteTurn(turn) {
        const fallbackNodes = [turn.root, turn.userBubble].filter(node =>
            node instanceof Element
        );
        if (hasForeignFallbackOwner(turn, currentChatIdentity)) return false;

        /* Unstable text/index fallbacks are usable only while currently mounted. */
        if (!turn.stableIdentity) {
            for (const node of fallbackNodes) {
                fallbackTurnOwnersByNode.set(node, currentChatIdentity);
            }
            return true;
        }

        if (
            turnBelongsToAnotherChat(turn.identity, currentChatIdentity)
        ) {
            return false;
        }

        rememberTurnIdentity(currentChatIdentity, turn.identity);
        for (const node of fallbackNodes) {
            stableTurnOwnersByNode.set(node, {
                identity: turn.identity,
                owner: turnRecordsByChat.get(currentChatIdentity).nodeOwner
            });
        }

        if (turn.kind === 'user') {
            for (const assistantUnit of getPairedAssistantUnits(turn)) {
                const unitIdentity = getAssistantUnitIdentity(assistantUnit);
                if (!unitIdentity) continue;

                const assistantIdentity = `assistant:${unitIdentity}`;
                if (
                    turnIdentitiesByChat.get(currentChatIdentity)?.has(assistantIdentity) ||
                    turnBelongsToAnotherChat(assistantIdentity, currentChatIdentity)
                ) {
                    continue;
                }

                rememberTurnIdentity(currentChatIdentity, assistantIdentity);
            }
        }

        return true;
    }

    function transferChatTurnIdentities(fromIdentity, toIdentity) {
        const sourceStore = turnRecordsByChat.get(fromIdentity);
        if (sourceStore) sourceStore.nodeOwner.chatIdentity = toIdentity;
        for (const turn of turns) {
            if (turn.stableIdentity) continue;

            for (const node of [turn.root, turn.userBubble]) {
                if (node instanceof Element && node.isConnected) {
                    fallbackTurnOwnersByNode.set(node, toIdentity);
                }
            }
        }

        const turnIdentities = turnIdentitiesByChat.get(fromIdentity);
        if (turnIdentities) {
            for (const turnIdentity of turnIdentities) {
                rememberTurnIdentity(toIdentity, turnIdentity);

                const owners = chatOwnersByTurnIdentity.get(turnIdentity);
                owners?.delete(fromIdentity);
                if (owners && owners.size === 0) {
                    chatOwnersByTurnIdentity.delete(turnIdentity);
                }
            }
            turnIdentitiesByChat.delete(fromIdentity);
        }

        if (!sourceStore) return;

        const targetStore = getTurnRecordStore(toIdentity);
        function transferEditCandidates(resolveIdentity) {
            for (const [key, candidate] of Array.from(userEditCandidates)) {
                if (candidate.chatIdentity !== fromIdentity) continue;
                const nextKey = resolveIdentity(key);
                candidate.chatIdentity = toIdentity;
                candidate.identity = resolveIdentity(candidate.identity);
                candidate.previousUserIdentity = resolveIdentity(candidate.previousUserIdentity);
                if (nextKey !== key) userEditCandidates.delete(key);
                userEditCandidates.set(nextKey, candidate);
            }
        }
        if (
            !targetStore.index.getEntries().length && !targetStore.turns.length &&
            !targetStore.byIdentity.size && !targetStore.identityAliases.size &&
            !targetStore.pairedAssistantToUser.size &&
            !targetStore.suppressedRemovedIdentities.size &&
            !targetStore.index.getSuppression().size
        ) {
            const entries = sourceStore.index.getEntries();
            if (
                entries.length !== sourceStore.byIdentity.size ||
                entries.some(entry => sourceStore.byIdentity.get(entry.identity) !== entry)
            ) synchronizeStoreWithIndex(sourceStore, [], toIdentity);
            transferEditCandidates(identity => identity);
            turnRecordsByChat.set(toIdentity, sourceStore);
            turnRecordsByChat.delete(fromIdentity);
            return;
        }

        targetStore.index.upsertObserved(sourceStore.index.getEntries());
        let identityChanges = [];
        if (sourceStore.index.hasSnapshot()) {
            const result = targetStore.index.applySnapshot({
                chatId: toIdentity.slice('conversation:'.length),
                branchKey: sourceStore.index.getBranchKey(),
                entries: sourceStore.index.getEntries(),
                pagination: { complete: false, cursor: null, hasError: false }
            });
            if (result.accepted) identityChanges = result.identityChanges;
        }
        targetStore.index.mergeSuppression(sourceStore.index.getSuppression());
        synchronizeStoreWithIndex(targetStore, identityChanges, toIdentity);

        function resolveTransferredIdentity(identity) {
            if (!identity) return identity;
            const canonical = resolveRememberedIdentity(sourceStore, identity) || identity;
            const record = sourceStore.byIdentity.get(canonical) ||
                sourceStore.index.resolveEntry({identity: canonical});
            return (record && targetStore.index.resolveEntry(record, {kind: record.kind})
                ?.identity) || identity;
        }
        transferEditCandidates(resolveTransferredIdentity);

        for (const record of sourceStore.index.getEntries()) {
            const canonical = resolveTransferredIdentity(record.identity);
            if (canonical !== record.identity) {
                targetStore.identityAliases.set(record.identity, canonical);
            }
        }
        for (const [alias, canonical] of sourceStore.identityAliases) {
            if (!targetStore.identityAliases.has(alias)) {
                targetStore.identityAliases.set(alias, resolveTransferredIdentity(canonical));
            }
        }

        for (const [assistantIdentity, userIdentity] of
            sourceStore.pairedAssistantToUser
        ) {
            const assistant = resolveTransferredIdentity(assistantIdentity);
            if (!targetStore.pairedAssistantToUser.has(assistant)) {
                targetStore.pairedAssistantToUser.set(
                    assistant,
                    resolveTransferredIdentity(userIdentity)
                );
            }
        }

        for (const [identity, suppression] of sourceStore.suppressedRemovedIdentities) {
            if (!targetStore.suppressedRemovedIdentities.has(identity)) {
                targetStore.suppressedRemovedIdentities.set(identity, suppression);
            }
        }

        for (const [assistantIdentity, userIdentity] of
            targetStore.pairedAssistantToUser
        ) {
            removePairedAssistantRecord(
                targetStore,
                assistantIdentity,
                userIdentity,
                toIdentity
            );
        }

        /* Route identities such as `route:/` can be reused by later chats. */
        turnRecordsByChat.delete(fromIdentity);
    }

    function clearNavigation() {
        cancelJumpSearch();
        clearExtendedScrollRange();

        turns = [];
        turnSignature = '';
        activeIndex = -1;
        mountedTurnsByIdentity.clear();

        if (activeRAF !== null) {
            cancelAnimationFrame(activeRAF);
            activeRAF = null;
        }

        if (barList) barList.replaceChildren();
        if (rail) rail.style.display = 'none';
        resetReplyNavigationForConversationChange();
        railDensityCacheKey = '';
        railLayoutSignature = '';

        if (preview) {
            preview.classList.remove('yw-visible');
        }

        if (previewUser) previewUser.textContent = '';
        if (previewAssistant) previewAssistant.textContent = '';
    }

    function handleRouteChange(scheduleProjection = true) {
        const identity = getChatIdentity();

        if (currentChatIdentity === null) {
            currentChatIdentity = identity;
            return;
        }

        if (identity === currentChatIdentity) return;

        cancelRebuildSchedule();

        cancelJumpSearch();
        userEditCandidates.clear();
        clearTimeout(contentRefreshTimer);
        contentRefreshTimer = null;
        pendingContentRefreshes.clear();
        latestNativePagination = null;
        nativeAdapterRetryPending = false;
        resetNativeAdapterRetryBackoff();

        /* 根页刚提交 composer 后生成的 /c/<id> 才保留当前新对话。 */
        if (
            newConversationSubmissionPending &&
            isConversationUrlPromotion(currentChatIdentity, identity)
        ) {
            transferChatTurnIdentities(currentChatIdentity, identity);
            currentChatIdentity = identity;
            lastLocatorDiagnostic = '';
            lastHistoryCapabilityDiagnostic = '';
            lastHistoryControlDiagnostic = '';
            resetReplyNavigationForConversationChange();
            clearNewConversationSubmission();
            startNativeLocator(identity);
            startNativeAdapter(identity);
            if (scheduleProjection) scheduleRebuild(0);
            return;
        }

        clearNewConversationSubmission();
        releaseConversationDOM(currentChatIdentity);
        currentChatIdentity = identity;
        lastLocatorDiagnostic = '';
        lastHistoryCapabilityDiagnostic = '';
        lastHistoryControlDiagnostic = '';

        clearNavigation();
        startNativeLocator(identity);
        startNativeAdapter(identity);
        if (scheduleProjection) scheduleRebuild(0);
    }

    function isConversationUrlPromotion(previousIdentity, identity) {
        if (
            !previousIdentity?.startsWith('route:') ||
            !identity?.startsWith('conversation:')
        ) {
            return false;
        }

        const match = window.location.pathname.match(/^(.*)\/c\/[^/]+\/?$/);
        if (!match) return false;

        const previousPath = previousIdentity
            .slice('route:'.length)
            .replace(/\/$/, '');
        const conversationBase = match[1].replace(/\/$/, '');

        return previousPath === conversationBase;
    }

    function clearNewConversationSubmission() {
        newConversationSubmissionPending = false;

        if (newConversationSubmissionTimer !== null) {
            clearTimeout(newConversationSubmissionTimer);
            newConversationSubmissionTimer = null;
        }
    }

    function markNewConversationSubmissionPending() {
        if (!currentChatIdentity?.startsWith('route:')) return;

        clearNewConversationSubmission();
        newConversationSubmissionPending = true;
        newConversationSubmissionTimer = setTimeout(() => {
            newConversationSubmissionPending = false;
            newConversationSubmissionTimer = null;
        }, 10000);
    }

    function observeNewConversationSubmissions() {
        document.addEventListener('submit', event => {
            if (!currentChatIdentity?.startsWith('route:')) return;

            const form = event.target;

            if (
                !(form instanceof Element) ||
                !form.matches('form') ||
                !form.querySelector(
                    '#prompt-textarea, [data-testid="prompt-textarea"], ' +
                    '[data-testid="composer-text-input"], [contenteditable="true"]'
                )
            ) {
                return;
            }

            markNewConversationSubmissionPending();
        }, true);

        document.addEventListener('click', event => {
            const target = event.target;

            if (!(target instanceof Element)) return;

            if (target.closest(
                '[data-testid="send-button"], ' +
                'button[aria-label*="Send"], button[aria-label*="发送"]'
            )) {
                markNewConversationSubmissionPending();
            } else if (
                newConversationSubmissionPending &&
                target.closest('a[href]')
            ) {
                clearNewConversationSubmission();
            }
        }, true);
    }

    function observeRouteChanges() {
        for (const method of ['pushState', 'replaceState']) {
            const original = history[method];

            if (original.__ywConversationNavigatorWrapped) continue;

            const wrapped = function (...args) {
                const result = original.apply(this, args);
                handleRouteChange();
                return result;
            };

            Object.defineProperty(
                wrapped,
                '__ywConversationNavigatorWrapped',
                { value: true }
            );

            history[method] = wrapped;
        }

        window.addEventListener('popstate', () => {
            clearNewConversationSubmission();
            handleRouteChange();
        });
        window.addEventListener('hashchange', handleRouteChange);
    }


    /******************************************************************
     * 找到 ChatGPT 中可导航的消息
     ******************************************************************/

    function queryAllIncludingRoot(root, selector) {
        const matches = [];

        if (root instanceof Element && root.matches(selector)) {
            matches.push(root);
        }

        if (root?.querySelectorAll) {
            matches.push(...root.querySelectorAll(selector));
        }

        return matches;
    }

    function isInHiddenSubtree(element) {
        /* Removed nodes are still collected briefly to preserve turn history. */
        if (!(element instanceof Element) || !element.isConnected) return false;

        for (
            let ancestor = element;
            ancestor instanceof Element;
            ancestor = ancestor.parentElement
        ) {
            if (ancestor.hasAttribute('hidden')) return true;

            const style = window.getComputedStyle(ancestor);
            if (style.display === 'none') return true;
        }

        const visibility = window.getComputedStyle(element).visibility;
        return visibility === 'hidden' || visibility === 'collapse';
    }

    /*
     * ChatGPT uses two kinds of DOM keys: stable turn/message UUIDs and
     * positional content-search fallback keys ("fallback-turn-N"). Positional
     * keys renumber whenever the virtualized window shifts, so they must
     * never become persistent identities.
     */
    function isFallbackSearchKey(value) {
        return typeof value === 'string' &&
            (
                value.startsWith('fallback-') ||
                value.startsWith('fallback:')
            );
    }

    function getMessageIds(value) {
        return String(value || '')
            .split(/\s+/)
            .map(id => id.trim())
            .filter(Boolean);
    }

    function getFirstMessageId(value) {
        return getMessageIds(value)[0] || '';
    }

    function collectMessageEvidenceIds(...sources) {
        const ids = new Set();
        for (const source of sources) {
            for (const value of [
                source?.userMessageId,
                source?.messageId,
                ...(Array.isArray(source?.userMessageIds)
                    ? source.userMessageIds
                    : []),
                ...(Array.isArray(source?.assistantMessageIds)
                    ? source.assistantMessageIds
                    : [])
            ]) {
                if (value) ids.add(value);
            }
        }
        return ids;
    }

    function uniqueMessageIds(...groups) {
        return Array.from(new Set(groups.flatMap(group =>
            Array.isArray(group) ? group : [group]).filter(Boolean)));
    }

    function getIdentityValue(identity) {
        const value = String(identity || '')
            .replace(/^(user|assistant):/, '');
        if (
            !value ||
            isFallbackSearchKey(value) ||
            value.startsWith('round:')
        ) {
            return '';
        }
        return value;
    }

    /*
     * Stable user-turn identity: the native turn key, then the user message
     * id, then a non-positional content-search key.
     */
    function getUserStableIdentity(bubble, root) {
        const turnKey = root.getAttribute('data-turn-key') || '';
        if (turnKey && !isFallbackSearchKey(turnKey)) {
            return `user:${turnKey}`;
        }

        const messageId = getFirstMessageId(
            bubble.getAttribute('data-chatgpt-search-message-ids') ||
            bubble.getAttribute('data-message-id')
        );
        if (messageId && !isFallbackSearchKey(messageId)) {
            return `user:${messageId}`;
        }

        const searchKey = root.getAttribute('data-content-search-turn-key') || '';
        if (searchKey && !isFallbackSearchKey(searchKey)) {
            return `user:${searchKey}`;
        }

        return '';
    }

    function collectTurns(scope = document) {
        const bubbles = queryAllIncludingRoot(
            scope,
            '[data-user-message-bubble="true"]'
        );

        const userTurns = [];
        const seen = new Set();

        for (const bubble of bubbles) {
            if (isInHiddenSubtree(bubble)) continue;

            /* 用户消息与 assistant 回复共用 turn wrapper。 */
            const root = getLogicalTurnWrapper(bubble);
            if (!root) continue;

            const fallbackKey = `turn-${userTurns.length}`;
            const stableIdentity = getUserStableIdentity(bubble, root);
            const identity = stableIdentity ||
                `fallback:${fallbackKey}:${normalizeText(
                    bubble.innerText || bubble.textContent || ''
                )}`;
            const key = stableIdentity || identity;

            /* 嵌套的 outer / content-search wrapper 同 key 时只保留一轮。 */
            if (seen.has(key)) continue;
            seen.add(key);

            const userTurn = {
                key,
                identity,
                root,
                userBubble: bubble,
                kind: 'user',
                stableIdentity: Boolean(stableIdentity)
            };
            const pairedAssistantUnits = getPairedAssistantUnits(userTurn);
            const pairedAssistantIdentities = pairedAssistantUnits
                .map(getAssistantUnitIdentity)
                .filter(Boolean)
                .map(unitIdentity => `assistant:${unitIdentity}`)
                .filter(assistantIdentity =>
                    !turnBelongsToAnotherChat(
                        assistantIdentity,
                        currentChatIdentity
                    )
                );

            userTurns.push({
                ...userTurn,
                pairedAssistantUnits,
                pairedAssistantIdentities,
            });
        }

        const observedUserTurns = userTurns.filter(turn =>
            !turnBelongsToAnotherChat(turn.identity, currentChatIdentity) &&
            !hasForeignFallbackOwner(turn, currentChatIdentity)
        );
        const pairedAssistantIdentities = new Set(
            observedUserTurns.flatMap(turn => turn.pairedAssistantIdentities)
        );
        const previouslyPairedAssistants =
            turnRecordsByChat.get(currentChatIdentity)?.pairedAssistantToUser;

        const result = observedUserTurns.slice();
        const assistantUnits = queryAllIncludingRoot(
            scope,
            ASSISTANT_UNIT_SELECTOR
        );

        for (const assistantUnit of assistantUnits) {
            if (isInHiddenSubtree(assistantUnit)) continue;

            const unitIdentity = getAssistantUnitIdentity(assistantUnit);
            if (!unitIdentity) continue;

            const key = `assistant:${unitIdentity}`;
            const isCurrentChatPair =
                !turnBelongsToAnotherChat(key, currentChatIdentity) &&
                (
                    pairedAssistantIdentities.has(key) ||
                    previouslyPairedAssistants?.has(key)
                );
            if (
                seen.has(key) ||
                isCurrentChatPair
            ) {
                continue;
            }
            seen.add(key);

            const messageTarget = assistantUnit.querySelector(
                '[data-chatgpt-selection-message-id]'
            ) || assistantUnit;

            result.push({
                key,
                identity: key,
                root: messageTarget,
                assistantUnit,
                userBubble: null,
                kind: 'assistant',
                stableIdentity: true
            });
        }

        result.sort((left, right) => {
            const leftNode = left.kind === 'user'
                ? left.root
                : left.assistantUnit;
            const rightNode = right.kind === 'user'
                ? right.root
                : right.assistantUnit;
            if (!leftNode || !rightNode) return 0;

            const position = leftNode.compareDocumentPosition(rightNode);
            if (position & Node.DOCUMENT_POSITION_DISCONNECTED) return 0;
            if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
            if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
            return 0;
        });

        return result;
    }

    function getAssistantUnitMessageIds(assistantUnit) {
        if (!assistantUnit) return [];
        const searchIds = getMessageIds(
            assistantUnit.getAttribute?.('data-chatgpt-search-message-ids')
        ).filter(id => !isFallbackSearchKey(id));
        const selectionIds = [];
        if (assistantUnit.matches?.('[data-chatgpt-selection-message-id]')) {
            selectionIds.push(
                assistantUnit.getAttribute('data-chatgpt-selection-message-id')
            );
        }
        for (const message of assistantUnit.querySelectorAll?.(
            '[data-chatgpt-selection-message-id]'
        ) || []) {
            selectionIds.push(message.getAttribute('data-chatgpt-selection-message-id'));
        }
        return uniqueMessageIds(searchIds, selectionIds.filter(id =>
            id && !isFallbackSearchKey(id)
        ));
    }

    function getAssistantUnitMessageId(assistantUnit) {
        return getAssistantUnitMessageIds(assistantUnit)[0] || '';
    }

    function findAssistantMessageTarget(assistantUnit, messageId) {
        if (!getAssistantUnitMessageIds(assistantUnit).includes(messageId)) return null;
        if (
            assistantUnit.matches?.('[data-chatgpt-selection-message-id]') &&
            assistantUnit.getAttribute('data-chatgpt-selection-message-id') === messageId
        ) {
            return assistantUnit;
        }
        for (const candidate of assistantUnit.querySelectorAll?.(
            '[data-chatgpt-selection-message-id]'
        ) || []) {
            if (candidate.getAttribute('data-chatgpt-selection-message-id') === messageId) {
                return candidate;
            }
        }
        return assistantUnit;
    }

    function getAssistantIdentityCandidates(assistantUnit) {
        const candidates = [];

        const messageId = getAssistantUnitMessageId(assistantUnit);
        if (messageId) candidates.push(messageId);

        const rawUnitIdentity =
            assistantUnit.getAttribute('data-content-search-unit-key') ||
            assistantUnit.getAttribute('data-chatgpt-search-unit-key') ||
            '';
        if (rawUnitIdentity && !isFallbackSearchKey(rawUnitIdentity)) {
            candidates.push(rawUnitIdentity);
        }

        const logicalWrapper = getLogicalTurnWrapper(assistantUnit);
        const logicalTurnKey = getTurnWrapperKey(logicalWrapper);
        if (logicalTurnKey && rawUnitIdentity) {
            candidates.push(`round:${JSON.stringify([
                logicalTurnKey,
                rawUnitIdentity
            ])}`);
        }

        /* Last resort: positional fallback keys; they may drift. */
        if (rawUnitIdentity && isFallbackSearchKey(rawUnitIdentity)) {
            candidates.push(rawUnitIdentity);
        }
        return candidates;
    }

    function resolveRememberedIdentity(store, identity) {
        if (!store || !identity) return '';
        const aliased = store.identityAliases.get(identity);
        if (aliased && store.byIdentity.has(aliased)) return aliased;
        if (store.byIdentity.has(identity)) return identity;
        return '';
    }

    function addEvidenceKeys(ids, identity, turnKey) {
        if (turnKey && !isFallbackSearchKey(turnKey)) ids.add(turnKey);
        const identityValue = getIdentityValue(identity);
        if (identityValue) ids.add(identityValue);
        return ids;
    }

    function getRecordEvidenceIds(record) {
        return addEvidenceKeys(collectMessageEvidenceIds(record), record?.identity, record?.turnKey);
    }

    function evidenceIsCompatible(recordIds, turnIds) {
        if (!recordIds?.size || !turnIds?.size) return true;
        for (const id of turnIds) {
            if (recordIds.has(id)) return true;
        }
        return false;
    }

    function assistantIdentityMatchesUnit(store, fullIdentity, assistantUnit) {
        const record = store.byIdentity.get(fullIdentity);
        if (!record || record.kind !== 'assistant') return false;

        const turnIds = new Set();
        const messageId = getAssistantUnitMessageId(assistantUnit);
        if (messageId) turnIds.add(messageId);
        const identityValue = getIdentityValue(fullIdentity);
        if (identityValue) turnIds.add(identityValue);

        return evidenceIsCompatible(getRecordEvidenceIds(record), turnIds);
    }

    function getAssistantUnitIdentity(assistantUnit) {
        const candidates = getAssistantIdentityCandidates(assistantUnit);
        if (!candidates.length) return '';

        const store = currentChatIdentity
            ? turnRecordsByChat.get(currentChatIdentity)
            : null;
        if (store?.identitiesByNode) {
            const remembered = resolveRememberedIdentity(
                store,
                store.identitiesByNode.get(assistantUnit)
            );
            if (
                remembered.startsWith('assistant:') &&
                assistantIdentityMatchesUnit(store, remembered, assistantUnit)
            ) {
                return remembered.slice('assistant:'.length);
            }

            for (const candidate of candidates) {
                const resolved = resolveRememberedIdentity(
                    store,
                    `assistant:${candidate}`
                );
                if (
                    resolved &&
                    assistantIdentityMatchesUnit(store, resolved, assistantUnit)
                ) {
                    return resolved.slice('assistant:'.length);
                }
            }
        }

        return candidates[0];
    }

    function getPairedAssistantUnits(turn) {
        if (!turn?.root) return [];

        const assistantUnits = Array.isArray(turn.pairedAssistantUnits)
            ? turn.pairedAssistantUnits
            : queryAllIncludingRoot(turn.root, ASSISTANT_UNIT_SELECTOR);

        return assistantUnits
            .filter(assistantUnit => {
                if (!isPairedAssistantUnit(turn, assistantUnit)) return false;

                const unitIdentity = getAssistantUnitIdentity(assistantUnit);
                return !unitIdentity || !turnBelongsToAnotherChat(
                    `assistant:${unitIdentity}`,
                    currentChatIdentity
                );
            });
    }

    function isPairedAssistantUnit(turn, assistantUnit) {
        if (turn?.kind !== 'user' || !turn.root || !assistantUnit) return false;

        const nearestTurnWrapper = getLogicalTurnWrapper(assistantUnit);
        const userTurnKey = getTurnWrapperKey(turn.root);

        return Boolean(
            turn.root.contains(assistantUnit) &&
            (
                nearestTurnWrapper === turn.root ||
                (
                    userTurnKey &&
                    getTurnWrapperKey(nearestTurnWrapper) === userTurnKey
                )
            )
        );
    }

    function getTurnWrapperKey(turnWrapper) {
        return turnWrapper?.getAttribute('data-turn-key') ||
            turnWrapper?.getAttribute('data-content-search-turn-key') ||
            '';
    }

    function getLogicalTurnWrapper(node) {
        /* The outer turn key identifies the round; inner content-search keys can differ. */
        return node?.closest('[data-turn-key]') ||
            node?.closest('[data-content-search-turn-key]') ||
            null;
    }


    /******************************************************************
     * 获取预览文字
     ******************************************************************/

    function normalizeText(text) {
        return String(text || '')
            .replace(/\r\n?/g, '\n')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function shorten(text, maxLength) {
        text = normalizeText(text);

        if (!text) return '';

        if (text.length <= maxLength) return text;

        return text.slice(0, maxLength).trimEnd() + '…';
    }

    function getFullUserText(turn) {
        return turn?.userBubble
            ? normalizeText(
                turn.userBubble.innerText || turn.userBubble.textContent || ''
            )
            : '';
    }

    function getUserText(turn) {
        const liveText = shorten(getFullUserText(turn), 1000);

        return liveText || turn?.userText || '';
    }

    function getNativeAssistantPreviewText(text) {
        const readableText = String(text || '')
            .replace(/image_group[\s\S]*?/gu, '')
            .replace(/cite[^]*/gu, '')
            .replace(/url([^]*)https?:\/\/[^]*/gu, '$1')
            .replace(/url[^]*/gu, '');
        return shorten(readableText, 2200);
    }

    function getAssistantText(turn) {
        if (turn?.assistantTextSource === 'native-complete' &&
            typeof turn.assistantText === 'string') {
            return getNativeAssistantPreviewText(turn.assistantText);
        }
        const pairedAssistantUnit = turn?.kind === 'user'
            ? getPairedAssistantUnits(turn)[0]
            : null;
        const contentRoot = turn?.kind === 'user'
            ? pairedAssistantUnit
            : turn?.assistantUnit || turn?.root;
        if (!contentRoot) return turn?.assistantText || '';

        /*
         * 第一优先级：
         * ChatGPT 当前用于最终回复 Markdown 的语义属性。
         */
        const markdownBlocks = contentRoot.querySelectorAll(
            '[data-markdown-text-style="assistant-message"]'
        );

        if (markdownBlocks.length > 0) {
            const text = Array.from(markdownBlocks)
                .map(node => node.innerText || node.textContent || '')
                .filter(Boolean)
                .join('\n\n');

            if (normalizeText(text)) {
                return shorten(text, 2200);
            }
        }

        /*
         * fallback：
         * 找 assistant unit。
         */
        const assistantUnit = contentRoot.matches?.(ASSISTANT_UNIT_SELECTOR)
            ? contentRoot
            : contentRoot.querySelector(ASSISTANT_UNIT_SELECTOR);

        if (assistantUnit) {
            const messageContent = assistantUnit.querySelector(
                '[data-chatgpt-selection-message-id]'
            ) || assistantUnit;
            let text =
                messageContent.innerText ||
                messageContent.textContent ||
                '';

            text = text.replace(
                /^\s*ChatGPT\s*说[：:]?\s*/i,
                ''
            );

            return shorten(text, 2200) || turn?.assistantText || '';
        }

        return turn?.assistantText || '';
    }

    function getConversationIndex(chatIdentity) {
        return getTurnRecordStore(chatIdentity).index;
    }

    function getTurnMessageIds(turn) {
        const userIds = getMessageIds(
            turn?.userBubble?.getAttribute('data-chatgpt-search-message-ids') ||
            turn?.userBubble?.getAttribute('data-message-id')
        );
        const assistantIds = [];
        const assistantUnits = turn?.kind === 'user'
            ? getPairedAssistantUnits(turn)
            : [turn?.assistantUnit || turn?.root].filter(Boolean);
        for (const unit of assistantUnits) {
            assistantIds.push(...getAssistantUnitMessageIds(unit));
        }
        const cleanAssistantIds = uniqueMessageIds(assistantIds);
        const userMessageId = userIds[0] || '';
        return {
            userMessageId,
            userMessageIds: userIds,
            assistantMessageIds: cleanAssistantIds,
            messageId: turn?.kind === 'assistant'
                ? cleanAssistantIds[0] || ''
                : userMessageId || cleanAssistantIds[0] || ''
        };
    }

    function toIndexIdentity(turn) {
        const messageIds = getTurnMessageIds(turn);
        const wrapperKey = getTurnWrapperKey(turn.root);
        const turnKey = turn.turnKey ||
            (wrapperKey && !isFallbackSearchKey(wrapperKey) ? wrapperKey : '');
        return {
            identity: turn.identity,
            turnKey,
            kind: turn.kind,
            userMessageId: turn.userMessageId || messageIds.userMessageId,
            userMessageIds: turn.userMessageIds || messageIds.userMessageIds,
            messageId: turn.messageId || messageIds.messageId,
            assistantMessageIds: turn.assistantMessageIds ||
                messageIds.assistantMessageIds
        };
    }

    function toIndexRecord(turn) {
        return {
            ...toIndexIdentity(turn),
            userText: turn.userText || getUserText(turn),
            assistantText: turn.assistantText || getAssistantText(turn),
            assistantTextSource: turn.assistantTextSource,
            assistantTextSourceMessageIds: turn.assistantTextSourceMessageIds,
            assistantTextUnresolvedReferenceMessageIds: turn.assistantTextUnresolvedReferenceMessageIds,
            userTextSnapshot: turn.userTextSnapshot,
            domUserTextBaseline: turn.domUserTextBaseline,
            preserveCommittedUserText: turn.preserveCommittedUserText
        };
    }

    function getTurnRecordStore(chatIdentity) {
        if (!turnRecordsByChat.has(chatIdentity)) {
            turnRecordsByChat.set(chatIdentity, {
                nodeOwner: {chatIdentity},
                turns: [],
                byIdentity: new Map(),
                identityAliases: new Map(),
                identitiesByNode: new WeakMap(),
                pairedAssistantToUser: new Map(),
                suppressedRemovedIdentities: new Map(),
                index: createConversationIndex()
            });
        }

        const store = turnRecordsByChat.get(chatIdentity);
        // Map insertion order is the recency list; the current chat is protected.
        turnRecordsByChat.delete(chatIdentity);
        turnRecordsByChat.set(chatIdentity, store);
        for (const identity of turnRecordsByChat.keys()) {
            if (turnRecordsByChat.size <= MAX_CACHED_CONVERSATIONS) break;
            if (identity === currentChatIdentity) continue;
            releaseConversationDOM(identity);
            turnRecordsByChat.delete(identity);
            for (const turnIdentity of turnIdentitiesByChat.get(identity) || []) {
                const owners = chatOwnersByTurnIdentity.get(turnIdentity);
                owners?.delete(identity);
                if (owners?.size === 0) chatOwnersByTurnIdentity.delete(turnIdentity);
            }
            turnIdentitiesByChat.delete(identity);
        }
        return store;
    }

    function releaseConversationDOM(chatIdentity) {
        const store = turnRecordsByChat.get(chatIdentity);
        if (!store) return;
        for (const record of new Set([...store.turns, ...store.byIdentity.values()])) {
            record.root = null;
            record.userBubble = null;
            record.assistantUnit = null;
        }
        store.identitiesByNode = new WeakMap();
    }

    function makeTurnRecord(entry) {
        entry.stableIdentity = true;
        entry.turnKey ||= '';
        entry.userMessageId ||= '';
        if (!Array.isArray(entry.userMessageIds)) entry.userMessageIds = [];
        entry.messageId ||= '';
        if (!Array.isArray(entry.assistantMessageIds)) entry.assistantMessageIds = [];
        if (!Array.isArray(entry.assistantTextSourceMessageIds)) {
            entry.assistantTextSourceMessageIds = [];
        }
        if (!Array.isArray(entry.assistantTextUnresolvedReferenceMessageIds)) {
            entry.assistantTextUnresolvedReferenceMessageIds = [];
        }
        entry.root ||= null;
        entry.userBubble ||= null;
        entry.assistantUnit ||= null;
        entry.userText ||= '';
        entry.userTextSnapshot ||= '';
        if (typeof entry.domUserTextBaseline !== 'string') {
            entry.domUserTextBaseline = null;
        }
        entry.assistantText ||= '';
        entry.preserveCommittedUserText = Boolean(entry.preserveCommittedUserText);
        return entry;
    }

    function synchronizeStoreWithIndex(store, identityChanges, chatIdentity) {
        const replacements = new Map(identityChanges.map(change =>
            [change.oldIdentity, change.identity]
        ));
        const remap = identity => replacements.get(identity) || identity;

        for (const [alias, canonical] of store.identityAliases) {
            store.identityAliases.set(alias, remap(canonical));
        }
        for (const [oldIdentity, identity] of replacements) {
            store.identityAliases.set(oldIdentity, identity);
            if (turnIdentitiesByChat.get(chatIdentity)?.has(oldIdentity)) {
                rememberTurnIdentity(chatIdentity, identity);
            }
        }

        if (replacements.size) {
            const pairs = new Map();
            for (const [assistant, user] of store.pairedAssistantToUser) {
                pairs.set(remap(assistant), remap(user));
            }
            store.pairedAssistantToUser = pairs;
            for (const [oldIdentity, identity] of replacements) {
                const suppression = store.suppressedRemovedIdentities.get(oldIdentity);
                if (suppression) {
                    store.suppressedRemovedIdentities.delete(oldIdentity);
                    store.suppressedRemovedIdentities.set(identity, suppression);
                }
            }
            for (const [identity, candidate] of Array.from(userEditCandidates)) {
                if (candidate.chatIdentity !== chatIdentity) continue;
                const nextIdentity = remap(identity);
                candidate.identity = remap(candidate.identity);
                candidate.previousUserIdentity = remap(candidate.previousUserIdentity);
                if (nextIdentity !== identity) {
                    userEditCandidates.delete(identity);
                    userEditCandidates.set(nextIdentity, candidate);
                }
            }
        }

        const entries = store.index.getEntries();
        store.byIdentity.clear();
        for (const entry of entries) {
            makeTurnRecord(entry);
            if (!store.byIdentity.has(entry.identity)) {
                store.byIdentity.set(entry.identity, entry);
            }
        }
        store.turns.splice(0, store.turns.length, ...entries);
    }

    function applyNativeSnapshotWithChanges(snapshot, chatIdentity = currentChatIdentity) {
        if (
            !snapshot ||
            chatIdentity !== currentChatIdentity ||
            getChatIdentity() !== chatIdentity
        ) {
            return {accepted: false};
        }

        const routeChatId = chatIdentity.startsWith('conversation:')
            ? chatIdentity.slice('conversation:'.length)
            : null;
        if (
            snapshot.chatId && routeChatId &&
            snapshot.chatId !== routeChatId &&
            snapshot.chatId !== chatIdentity
        ) {
            return {accepted: false};
        }

        const store = getTurnRecordStore(chatIdentity);
        const hadSnapshot = store.index.hasSnapshot();
        const previousBranch = store.index.getBranchKey();
        const bodyAndDOM = new Set([
            'userText', 'assistantText', 'userTextSnapshot',
            'assistantTextSource', 'assistantTextSourceMessageIds',
            'assistantTextUnresolvedReferenceMessageIds',
            'domUserTextBaseline', 'preserveCommittedUserText',
            'root', 'userBubble', 'assistantUnit'
        ]);
        const structureKey = record => JSON.stringify(
            Object.keys(record).filter(key => !bodyAndDOM.has(key)).sort()
                .map(key => [key, record[key]])
        );
        // The comparison is transient; record bodies have one persistent owner.
        const previous = store.index.getEntries().map(record => ({
            structure: structureKey(record),
            userText: record.userText || '',
            assistantText: record.assistantText || ''
        }));
        const result = store.index.applySnapshot(snapshot);
        if (!result.accepted) return {accepted: false};

        synchronizeStoreWithIndex(store, result.identityChanges, chatIdentity);
        const entries = store.index.getEntries();
        if (result.branchChanged) {
            const acceptedIdentities = new Set(
                entries.map(record => record.identity)
            );
            for (const identity of store.suppressedRemovedIdentities.keys()) {
                if (acceptedIdentities.has(identity)) {
                    store.suppressedRemovedIdentities.delete(identity);
                }
            }
        }
        const structureChanged = !hadSnapshot ||
            result.branchChanged ||
            previous.length !== entries.length ||
            entries.some((record, index) =>
                structureKey(record) !== previous[index].structure
            );
        const changedIdentities = structureChanged ? [] : entries
            .filter((record, index) =>
                (record.userText || '') !== previous[index].userText ||
                (record.assistantText || '') !== previous[index].assistantText
            )
            .map(record => record.identity);
        return {accepted: true, structureChanged, changedIdentities};
    }

    function applyNativeSnapshot(snapshot, chatIdentity = currentChatIdentity) {
        return applyNativeSnapshotWithChanges(snapshot, chatIdentity).accepted;
    }

    function acceptNativeSnapshot(snapshot, chatIdentity = currentChatIdentity) {
        const changes = applyNativeSnapshotWithChanges(snapshot, chatIdentity);
        if (!changes.accepted) return false;
        if (chatIdentity === currentChatIdentity) {
            nativeAdapterRetryPending = false;
            resetNativeAdapterRetryBackoff();
            if (nativeAdapterError) {
                nativeAdapterError = null;
                reportRouteCapability('Native history', 'ready');
            }
            latestNativePagination = snapshot?.pagination || null;
            scheduleNativeSnapshotProjection(changes);
            updateHistoryControl();
        }
        return true;
    }

    function scheduleNativeSnapshotRefresh() {
        if (!nativeAdapter || !currentChatIdentity) return;
        clearTimeout(nativeSnapshotTimer);
        const adapter = nativeAdapter;
        const chatIdentity = currentChatIdentity;
        const epoch = nativeAdapterEpoch;
        nativeSnapshotTimer = setTimeout(async () => {
            nativeSnapshotTimer = null;
            try {
                const snapshot = await adapter.readSnapshot();
                if (
                    adapter !== nativeAdapter ||
                    epoch !== nativeAdapterEpoch ||
                    chatIdentity !== currentChatIdentity
                ) {
                    return;
                }
                acceptNativeSnapshot(snapshot, chatIdentity);
            } catch (error) {
                if (epoch === nativeAdapterEpoch) {
                    nativeAdapterError = error;
                    nativeAdapterRetryPending = isRetryableNativeBindingError(error);
                    if (nativeAdapterRetryPending) {
                        bumpNativeAdapterRetryBackoff();
                    } else {
                        resetNativeAdapterRetryBackoff();
                    }
                    reportRouteCapability('Native history', 'unavailable', error);
                    updateHistoryControl();
                }
            }
        }, 240);
    }

    function removePairedAssistantRecord(
        store,
        assistantIdentity,
        userIdentity,
        chatIdentity = currentChatIdentity
    ) {
        if (turnBelongsToAnotherChat(assistantIdentity, chatIdentity)) return;

        if (
            store.pairedAssistantToUser.get(assistantIdentity) !== userIdentity
        ) {
            return;
        }

        const record = store.byIdentity.get(assistantIdentity);
        if (record?.kind !== 'assistant') return;

        store.byIdentity.delete(assistantIdentity);
        store.turns = store.turns.filter(turn =>
            turn.identity !== assistantIdentity
        );
        store.index.retire(assistantIdentity);
    }

    function insertTurnRecord(records, record, observed = []) {
        const observedIndex = observed.findIndex(turn =>
            turn.identity === record.identity
        );
        let previousAnchorIndex = -1;
        let nextAnchorIndex = -1;

        for (let index = observedIndex - 1; index >= 0; index--) {
            previousAnchorIndex = records.findIndex(existing =>
                existing.identity === observed[index].identity
            );
            if (previousAnchorIndex >= 0) {
                break;
            }
        }

        for (let index = observedIndex + 1; index < observed.length; index++) {
            nextAnchorIndex = records.findIndex(existing =>
                existing.identity === observed[index].identity
            );
            if (nextAnchorIndex >= 0) {
                break;
            }
        }

        const lowerBound = previousAnchorIndex >= 0
            ? previousAnchorIndex + 1
            : 0;
        const upperBound = nextAnchorIndex >= 0
            ? nextAnchorIndex
            : records.length;
        const insertionIndex = Math.max(lowerBound, upperBound);
        records.splice(insertionIndex, 0, record);
    }

    function enforceObservedTurnOrder(records, observed) {
        let previousIdentity = null;

        for (const turn of observed) {
            let turnIndex = records.findIndex(record =>
                record.identity === turn.identity
            );
            if (turnIndex < 0) continue;

            if (previousIdentity) {
                const previousIndex = records.findIndex(record =>
                    record.identity === previousIdentity
                );

                if (previousIndex >= 0 && turnIndex <= previousIndex) {
                    const [record] = records.splice(turnIndex, 1);
                    const updatedPreviousIndex = records.findIndex(item =>
                        item.identity === previousIdentity
                    );
                    turnIndex = updatedPreviousIndex + 1;
                    records.splice(turnIndex, 0, record);
                }
            }

            previousIdentity = turn.identity;
        }
    }

    function updateTurnRecord(record, observed, includeNodeReferences) {
        const liveObservation = Boolean(observed.root?.isConnected);
        const liveRecord = Boolean(record.root?.isConnected);
        const fullUserText = getFullUserText(observed);
        const userText = shorten(fullUserText, 1000);
        const ids = getTurnMessageIds(observed);
        const observedMessageIds = ids.assistantMessageIds;
        const completeAssistantMessageIds = getNativeCompleteAssistantMessageIds(record);
        const assistantMessageReplaced = completeAssistantMessageIds.length > 0 &&
            observedMessageIds.length > 0 &&
            !sharesMessageId(completeAssistantMessageIds, observedMessageIds);
        if (assistantMessageReplaced) {
            record.assistantText = '';
            clearAssistantTextSource(record, 'dom');
        }
        const assistantText = completeAssistantMessageIds.length > 0 && !assistantMessageReplaced
            ? record.assistantText
            : getAssistantText(observed);
        const conflictsWithCommittedEdit = record.preserveCommittedUserText &&
            fullUserText !== record.userTextSnapshot;
        if (
            observed.kind === 'user' &&
            observed.userBubble &&
            !conflictsWithCommittedEdit &&
            (
                liveObservation ||
                (!record.preserveCommittedUserText && !record.userTextSnapshot)
            )
        ) {
            record.userTextSnapshot = fullUserText;
            record.domUserTextBaseline = fullUserText;
            if (userText) record.userText = userText;
        }
        if (
            assistantText &&
            (liveObservation || (!liveRecord && !record.assistantText))
        ) {
            record.assistantText = assistantText;
            if (record.assistantTextSource !== 'native-complete') {
                clearAssistantTextSource(record, 'dom');
            }
        }

        if (!includeNodeReferences || !observed.root?.isConnected) return;

        record.root = observed.root;
        record.userBubble = observed.userBubble?.isConnected
            ? observed.userBubble
            : null;
        record.assistantUnit = observed.assistantUnit?.isConnected
            ? observed.assistantUnit
            : null;

        if (!record.assistantUnit && record.kind === 'user') {
            record.assistantUnit =
                getPairedAssistantUnits(observed)[0] || null;
        }

        const wrapperKey = getTurnWrapperKey(record.root);
        if (wrapperKey && !isFallbackSearchKey(wrapperKey)) {
            record.turnKey = wrapperKey;
        }
        if (ids.userMessageId) record.userMessageId = ids.userMessageId;
        if (ids.userMessageIds.length) {
            record.userMessageIds = uniqueMessageIds(record.userMessageIds, ids.userMessageIds);
        }
        if (ids.messageId) record.messageId = ids.messageId;
        if (assistantMessageReplaced) {
            record.assistantMessageIds = uniqueMessageIds(ids.assistantMessageIds);
        } else if (ids.assistantMessageIds.length) {
            record.assistantMessageIds = uniqueMessageIds(record.assistantMessageIds, ids.assistantMessageIds);
        }
    }

    function updateObservedTurnContent(observed) {
        if (
            !currentChatIdentity || getChatIdentity() !== currentChatIdentity ||
            !observed?.stableIdentity || !observed.root?.isConnected
        ) return null;

        const store = turnRecordsByChat.get(currentChatIdentity);
        if (!store) return null;
        const remembered = resolveRememberedIdentity(store, observed.identity);
        const record = store.byIdentity.get(remembered) ||
            store.index.resolveEntry(toIndexIdentity(observed), {kind: observed.kind});
        if (
            !record || record.kind !== observed.kind ||
            store.byIdentity.get(record.identity) !== record ||
            store.suppressedRemovedIdentities.has(record.identity)
        ) return null;

        // This path only refreshes body text; identities and order are unchanged.
        updateTurnRecord(record, observed, false);
        return record;
    }

    function asElement(node) {
        return node instanceof Element ? node : node?.parentElement || null;
    }

    function getTurnNodes(turn) {
        return [
            turn?.root,
            turn?.userBubble,
            turn?.assistantUnit,
            ...(turn?.pairedAssistantUnits || [])
        ].filter(Boolean);
    }

    function findKnownUserTurnContainingNode(node) {
        const element = asElement(node);
        if (!element || !currentChatIdentity) return null;

        const store = turnRecordsByChat.get(currentChatIdentity);
        const wrapper = getLogicalTurnWrapper(element);
        const bubble = element.closest('[data-user-message-bubble="true"]');
        const rawIdentities = [
            getTurnWrapperKey(wrapper),
            getFirstMessageId(
                bubble?.getAttribute('data-chatgpt-search-message-ids')
            )
        ].filter(value => value && !isFallbackSearchKey(value));

        let record = null;
        if (store?.identitiesByNode) {
            for (const node of [bubble, wrapper]) {
                const remembered = resolveRememberedIdentity(
                    store,
                    store.identitiesByNode.get(node)
                );
                if (remembered?.startsWith('user:')) {
                    record = store.byIdentity.get(remembered) || null;
                    if (record) break;
                }
            }
        }
        if (!record) {
            for (const rawIdentity of rawIdentities) {
                const identity = `user:${rawIdentity}`;
                const resolved = resolveRememberedIdentity(store, identity) ||
                    identity;
                record = store?.byIdentity.get(resolved) || null;
                if (record) break;
            }
        }
        if (record?.kind !== 'user') return null;

        return {
            ...record,
            root: wrapper || bubble,
            userBubble: wrapper?.querySelector(
                '[data-user-message-bubble="true"]'
            ) || bubble
        };
    }

    function findKnownUserContentTurn(node) {
        const element = asElement(node);
        const userBubble = element?.closest(
            '[data-user-message-bubble="true"]'
        );
        if (userBubble) return findKnownUserTurnContainingNode(userBubble);

        const editor = element?.matches(INLINE_USER_EDITOR_SELECTOR)
            ? element
            : element?.closest(INLINE_USER_EDITOR_SELECTOR);
        return editor ? findKnownUserTurnContainingNode(editor) : null;
    }

    function getInlineUserEditors(root) {
        if (!(root instanceof Element)) return [];

        const editors = [];
        if (root.matches(INLINE_USER_EDITOR_SELECTOR)) editors.push(root);
        editors.push(...root.querySelectorAll(INLINE_USER_EDITOR_SELECTOR));
        return editors;
    }

    function getInlineEditorText(editor) {
        if (!(editor instanceof Element)) return '';
        const text = 'value' in editor
            ? editor.value
            : editor.innerText || editor.textContent || '';
        return normalizeText(text);
    }

    function rememberUserEditCandidate(turn, editor) {
        if (!turn?.stableIdentity || turn.kind !== 'user') return;

        const store = turnRecordsByChat.get(currentChatIdentity);
        const branchTurns = store?.index.hasSnapshot()
            ? store.index.getEntries()
            : store?.turns || [];
        const pivotIndex = branchTurns.findIndex(record =>
            record.identity === turn.identity
        );
        const record = store?.byIdentity.get(turn.identity);
        if (!record || pivotIndex < 0) return;

        let candidate = userEditCandidates.get(turn.identity);
        if (!candidate) {
            let previousUserIdentity = null;
            for (let index = pivotIndex - 1; index >= 0; index--) {
                if (branchTurns[index].kind === 'user') {
                    previousUserIdentity = branchTurns[index].identity;
                    break;
                }
            }

            candidate = {
                chatIdentity: currentChatIdentity,
                identity: turn.identity,
                baselineText: typeof record.domUserTextBaseline === 'string'
                    ? record.domUserTextBaseline
                    : getFullUserText(turn),
                previousUserIdentity,
                root: turn.root,
                userBubble: turn.userBubble,
                editor: null
            };
            userEditCandidates.set(turn.identity, candidate);
        }

        if (editor) {
            candidate.editor = editor;
            if (editor.isConnected || candidate.latestEditorText === undefined) {
                candidate.latestEditorText = getInlineEditorText(editor);
            }
        }
        if (turn.root?.isConnected) candidate.root = turn.root;
        if (turn.userBubble?.isConnected) candidate.userBubble = turn.userBubble;
    }

    function captureUserEditCandidatesFromMutation(mutation) {
        const boundaryTurn = findKnownUserTurnContainingNode(mutation.target);
        const nodes = [
            ...(boundaryTurn ? [mutation.target] : []),
            ...Array.from(mutation.addedNodes || []),
            ...Array.from(mutation.removedNodes || [])
        ];

        for (const node of nodes) {
            const element = asElement(node);
            if (!element) continue;

            const turn = findKnownUserTurnContainingNode(element) || boundaryTurn;
            if (!turn) continue;

            const editors = [];
            const enclosingEditor = element.matches(INLINE_USER_EDITOR_SELECTOR)
                ? element
                : element.closest(INLINE_USER_EDITOR_SELECTOR);
            if (enclosingEditor) editors.push(enclosingEditor);
            if (element.matches(INLINE_USER_EDITOR_SELECTOR)) {
                editors.push(element);
            }
            editors.push(...element.querySelectorAll(INLINE_USER_EDITOR_SELECTOR));
            for (const editor of editors) {
                rememberUserEditCandidate(turn, editor);
            }
        }
    }

    function turnMatchesEditRoot(turn, candidate) {
        const root = candidate.root;
        return Boolean(
            root?.isConnected &&
            turn?.root?.isConnected &&
            (
                root === turn.root ||
                root.contains(turn.root) ||
                turn.root.contains(root) ||
                root.contains(turn.userBubble) ||
                turn.root.contains(candidate.userBubble)
            )
        );
    }

    function findEditReplacement(candidate, store, observed) {
        const users = observed.filter(turn =>
            turn.kind === 'user' && turn.stableIdentity
        );

        const sameRootReplacement = users.find(turn =>
            turn.identity !== candidate.identity &&
            turnMatchesEditRoot(turn, candidate)
        );
        if (sameRootReplacement) return sameRootReplacement;

        if (
            candidate.latestEditorText &&
            candidate.latestEditorText !== candidate.baselineText
        ) {
            const editedTextReplacement = users.find(turn =>
                turn.identity !== candidate.identity &&
                !store.byIdentity.has(turn.identity) &&
                getFullUserText(turn) === candidate.latestEditorText
            );
            if (editedTextReplacement) return editedTextReplacement;
        }

        for (let index = 0; index < users.length; index++) {
            const turn = users[index];
            if (
                turn.identity === candidate.identity ||
                store.byIdentity.has(turn.identity)
            ) {
                continue;
            }

            const previousIdentity = users[index - 1]?.identity || null;
            const atKnownBoundary = candidate.previousUserIdentity
                ? previousIdentity === candidate.previousUserIdentity
                : index === 0;
            if (atKnownBoundary) return turn;
        }

        return null;
    }

    function resetPreviewAfterEdit() {
        clearTimeout(hideTimer);
        hideTimer = null;
        preview?.classList.remove('yw-visible', 'yw-assistant-only');
        if (previewUser) previewUser.textContent = '';
        if (previewAssistant) previewAssistant.textContent = '';
    }

    function reconcileEditedBranch(
        store,
        identity,
        keepPivot,
        observed,
        replacementIdentity = null
    ) {
        const branchTurns = store.index.hasSnapshot()
            ? [...store.index.getEntries()]
            : [...store.turns];
        const boundary = branchTurns.findIndex(record =>
            record.identity === identity
        );
        if (boundary < 0) return null;

        const retainedIdentity = keepPivot ? identity : replacementIdentity;
        const keepRecord = retainedIdentity
            ? store.byIdentity.get(retainedIdentity)
            : null;
        const editedTurn = keepPivot
            ? observed.find(turn => turn.identity === identity && turn.kind === 'user')
            : null;
        const committedText = editedTurn
            ? getFullUserText(editedTurn)
            : (keepRecord?.userTextSnapshot || keepRecord?.userText || '');
        store.index.pruneFrom(identity, {
            keepIdentity: keepPivot,
            userText: keepPivot ? shorten(committedText, 1000) : undefined,
            userTextSnapshot: keepPivot ? committedText : undefined,
            domUserTextBaseline: keepPivot ? committedText : undefined
        });
        const removedRecords = branchTurns.slice(boundary).filter(record =>
            record !== keepRecord
        );
        const removedIdentities = new Set(
            removedRecords.map(record => record.identity)
        );

        if (keepPivot && keepRecord) {
            keepRecord.preserveCommittedUserText = true;
            keepRecord.assistantText = '';
            clearAssistantTextSource(keepRecord, 'dom');
            keepRecord.assistantUnit = null;
        }

        for (const [assistantIdentity, userIdentity] of
            Array.from(store.pairedAssistantToUser)
        ) {
            if (
                removedIdentities.has(assistantIdentity) ||
                removedIdentities.has(userIdentity) ||
                (keepPivot && userIdentity === identity)
            ) {
                store.pairedAssistantToUser.delete(assistantIdentity);
                const assistantRecord = store.byIdentity.get(assistantIdentity);
                if (assistantRecord?.kind === 'assistant') {
                    removedIdentities.add(assistantIdentity);
                    store.byIdentity.delete(assistantIdentity);
                }
            }
        }

        for (const removedIdentity of removedIdentities) {
            store.byIdentity.delete(removedIdentity);
            store.suppressedRemovedIdentities.set(removedIdentity, {
                awaitingUnmount: observed.some(turn =>
                    turn.identity === removedIdentity
                )
            });
        }

        const retainedPrefix = branchTurns.slice(0, boundary).filter(record =>
            record !== keepRecord
        );
        store.turns = retainedPrefix;
        if (keepRecord) store.turns.push(keepRecord);

        cancelJumpSearch();
        resetPreviewAfterEdit();
        userEditCandidates.clear();
        return {
            removedIdentities,
            replacementIdentity: keepPivot ? null : replacementIdentity,
            insertionIndex: retainedPrefix.length
        };
    }

    function reconcileObservedEdits(store, observed) {
        for (const turn of observed) {
            if (turn.kind !== 'user' || !turn.stableIdentity) continue;
            for (const editor of getInlineUserEditors(turn.root)) {
                rememberUserEditCandidate(turn, editor);
            }
        }

        for (const [identity, candidate] of userEditCandidates) {
            if (candidate.chatIdentity !== currentChatIdentity) {
                userEditCandidates.delete(identity);
                continue;
            }

            const oldTurn = observed.find(turn =>
                turn.identity === candidate.identity && turn.kind === 'user'
            );
            const hasEditor = Boolean(
                (
                    candidate.editor?.isConnected &&
                    candidate.editor.matches(INLINE_USER_EDITOR_SELECTOR)
                ) ||
                (
                    candidate.root?.isConnected &&
                    getInlineUserEditors(candidate.root).length
                ) ||
                (
                    oldTurn?.root?.isConnected &&
                    getInlineUserEditors(oldTurn.root).length
                )
            );
            if (hasEditor) continue;

            const replacement = findEditReplacement(candidate, store, observed);
            if (replacement) {
                return reconcileEditedBranch(
                    store,
                    candidate.identity,
                    false,
                    observed,
                    replacement.identity
                );
            }

            if (oldTurn) {
                if (getFullUserText(oldTurn) !== candidate.baselineText) {
                    return reconcileEditedBranch(
                        store,
                        candidate.identity,
                        true,
                        observed
                    );
                }

                /* The editor closed without changing the committed user turn. */
                userEditCandidates.delete(identity);
            }
        }

        return null;
    }

    function getTurnEvidenceIds(turn) {
        return addEvidenceKeys(collectMessageEvidenceIds(getTurnMessageIds(turn), turn),
            turn?.identity, getTurnWrapperKey(turn?.root));
    }

    function findAdjacentRecordOfKind(records, startIndex, direction, kind) {
        for (
            let index = startIndex + direction;
            index >= 0 && index < records.length;
            index += direction
        ) {
            if (records[index].kind === kind) return records[index];
        }
        return null;
    }

    function findAdjacentObservedTurn(observedTurns, startIndex, direction, kind) {
        for (
            let index = startIndex + direction;
            index >= 0 && index < observedTurns.length;
            index += direction
        ) {
            if (observedTurns[index].kind === kind) return observedTurns[index];
        }
        return null;
    }

    /*
     * Last-resort migration for a turn whose stable keys are temporarily
     * missing after a node re-mount: match an unmounted record with the same
     * user text and identical neighboring user turns. This mirrors the edit
     * reconciliation boundary test, so repeated identical messages are not
     * collapsed by accident.
     */
    function findUnstableTurnReplacement(store, turn, observedTurns) {
        if (turn.kind !== 'user') return null;
        const text = normalizeText(getFullUserText(turn));
        if (!text) return null;

        const candidates = store.turns.filter(record =>
            record.kind === 'user' &&
            !record.root?.isConnected &&
            normalizeText(record.userTextSnapshot || record.userText || '') === text
        );
        if (candidates.length !== 1) return null;

        const candidate = candidates[0];
        const turnIndex = store.turns.indexOf(candidate);
        if (turnIndex < 0) return null;

        const observedIndex = observedTurns.indexOf(turn);
        const previousObserved = findAdjacentObservedTurn(
            observedTurns,
            observedIndex,
            -1,
            'user'
        );
        const nextObserved = findAdjacentObservedTurn(
            observedTurns,
            observedIndex,
            1,
            'user'
        );
        const previousRecord = findAdjacentRecordOfKind(
            store.turns,
            turnIndex,
            -1,
            'user'
        );
        const nextRecord = findAdjacentRecordOfKind(
            store.turns,
            turnIndex,
            1,
            'user'
        );

        if (
            (previousObserved?.identity || null) !==
            (previousRecord?.identity || null)
        ) {
            return null;
        }
        if (
            nextObserved &&
            (nextObserved.identity || null) !== (nextRecord?.identity || null)
        ) {
            return null;
        }
        if (!nextObserved && nextRecord?.root?.isConnected) return null;

        return candidate;
    }

    /*
     * The DOM presentation identity (data-turn-key / search keys / message
     * ids) can drift while the logical turn stays the same. Before a turn is
     * merged into the store, migrate it onto an already known identity when
     * one is evidenced (node lineage, alias table, or the native index).
     */
    function reconcileObservedTurnIdentities(observedTurns) {
        if (!currentChatIdentity || !observedTurns?.length) return;
        const store = getTurnRecordStore(currentChatIdentity);

        for (const turn of observedTurns) {
            if (!turn?.identity) continue;

            const expectedPrefix = turn.kind === 'user'
                ? 'user:'
                : 'assistant:';
            const turnNodes = getTurnNodes(turn);
            let canonical = '';

            if (turn.stableIdentity) {
                canonical = resolveRememberedIdentity(
                    store,
                    store.identityAliases.get(turn.identity)
                );
            }

            if (!canonical) {
                for (const node of turnNodes) {
                    if (!(node instanceof Element) || !node.isConnected) {
                        continue;
                    }
                    const remembered = resolveRememberedIdentity(
                        store,
                        store.identitiesByNode.get(node)
                    );
                    if (
                        !remembered ||
                        !remembered.startsWith(expectedPrefix)
                    ) {
                        continue;
                    }
                    const record = store.byIdentity.get(remembered);
                    if (!record || record.kind !== turn.kind) continue;
                    if (!evidenceIsCompatible(
                        getRecordEvidenceIds(record),
                        getTurnEvidenceIds(turn)
                    )) {
                        continue;
                    }
                    canonical = remembered;
                    break;
                }
            }

            if (!canonical && turn.stableIdentity) {
                const entry = store.index.resolveEntry(
                    toIndexRecord(turn),
                    {kind: turn.kind}
                );
                if (entry?.identity && entry.identity !== turn.identity) {
                    canonical = entry.identity;
                }
            }

            if (!canonical && !turn.stableIdentity) {
                const replacement = findUnstableTurnReplacement(
                    store,
                    turn,
                    observedTurns
                );
                if (replacement) canonical = replacement.identity;
            }

            if (canonical && canonical !== turn.identity) {
                if (turn.stableIdentity) {
                    store.identityAliases.set(turn.identity, canonical);
                }
                turn.identity = canonical;
                turn.stableIdentity = true;
            }

            if (!turn.stableIdentity || !turn.identity) continue;
            for (const node of turnNodes) {
                if (node instanceof Element && node.isConnected) {
                    store.identitiesByNode.set(node, turn.identity);
                }
            }
        }
    }

    function getRecordMatchAliases(record) {
        const result = new Set();
        if (record?.turnKey && record?.kind) {
            result.add(`turn:${record.kind}:${record.turnKey}`);
        }
        for (const messageId of collectMessageEvidenceIds(record)) {
            result.add(`message:${messageId}`);
        }
        return result;
    }

    function mergeTurnRecordFields(target, source) {
        if (!source) return;
        if (!target.userText && source.userText) {
            target.userText = source.userText;
        }
        if (!target.userTextSnapshot && source.userTextSnapshot) {
            target.userTextSnapshot = source.userTextSnapshot;
        }
        if (
            target.domUserTextBaseline == null &&
            source.domUserTextBaseline != null
        ) {
            target.domUserTextBaseline = source.domUserTextBaseline;
        }
        const targetCompleteIds = getNativeCompleteAssistantMessageIds(target);
        const sourceCompleteIds = getNativeCompleteAssistantMessageIds(source);
        const sourceAssistantIds = Array.isArray(source.assistantMessageIds)
            ? source.assistantMessageIds
            : [];
        const replacesCompletedMessage = targetCompleteIds.length > 0 &&
            sourceAssistantIds.length > 0 &&
            !sharesMessageId(targetCompleteIds, sourceAssistantIds);
        const unresolvedCompletedMessage = sharesMessageId(
            targetCompleteIds,
            source.assistantTextUnresolvedReferenceMessageIds
        );
        const preserveCompletedText = targetCompleteIds.length > 0 && (
            unresolvedCompletedMessage ||
            !replacesCompletedMessage &&
                !sourceCompleteIds.length &&
                source.assistantTextSource !== 'native-plain'
        );

        if (sourceCompleteIds.length > 0 && !preserveCompletedText) {
            target.assistantText = source.assistantText || '';
            copyAssistantTextSource(target, source);
        } else if (targetCompleteIds.length > 0) {
            if (!preserveCompletedText && (replacesCompletedMessage || source.assistantText)) {
                target.assistantText = source.assistantText || '';
                copyAssistantTextSource(target, source);
            }
        } else if (source.assistantText && !target.assistantText) {
            target.assistantText = source.assistantText;
            copyAssistantTextSource(target, source);
        }
        target.userMessageId = target.userMessageId || source.userMessageId || '';
        target.userMessageIds = uniqueMessageIds(target.userMessageIds, source.userMessageIds);
        target.messageId = target.messageId || source.messageId || '';
        target.assistantMessageIds = uniqueMessageIds(target.assistantMessageIds, source.assistantMessageIds);
        if (!target.turnKey && source.turnKey) target.turnKey = source.turnKey;
        for (const key of ['root', 'userBubble', 'assistantUnit']) {
            if (
                !target[key]?.isConnected &&
                source[key]?.isConnected
            ) {
                target[key] = source[key];
            }
        }
        if (source.preserveCommittedUserText) {
            target.preserveCommittedUserText = true;
        }
    }

    function collapseDuplicateTurnRecord(store, canonical, duplicate) {
        if (canonical.kind !== 'user' && duplicate.kind === 'user') {
            const swap = canonical;
            canonical = duplicate;
            duplicate = swap;
        }

        if (canonical.kind === 'user' && duplicate.kind === 'assistant') {
            store.pairedAssistantToUser.set(
                duplicate.identity,
                canonical.identity
            );
            removePairedAssistantRecord(
                store,
                duplicate.identity,
                canonical.identity,
                currentChatIdentity
            );
        } else if (duplicate.kind === canonical.kind) {
            mergeTurnRecordFields(canonical, duplicate);
        } else {
            return;
        }

        store.byIdentity.delete(duplicate.identity);
        store.turns = store.turns.filter(record =>
            record.identity !== duplicate.identity
        );
        store.index.retire(duplicate.identity);
        store.identityAliases.set(duplicate.identity, canonical.identity);
    }

    /*
     * Records are kept across virtualization, so stale identities can pile
     * up as extra bars. Once two records share a proven message/turn alias
     * they are the same logical turn and the newer one is folded back.
     */
    function collapseDuplicateTurnRecords(store) {
        if (!store?.turns?.length) return 0;

        const ownerByAlias = new Map();
        const canonicalOf = new Map();
        const duplicates = [];

        function resolveCanonical(record) {
            let current = record;
            const seen = new Set();
            while (canonicalOf.has(current) && !seen.has(current)) {
                seen.add(current);
                current = canonicalOf.get(current);
            }
            return current;
        }

        for (const record of store.turns) {
            if (!record?.identity) continue;
            if (
                store.suppressedRemovedIdentities?.has(record.identity)
            ) {
                continue;
            }

            let canonical = null;
            for (const alias of getRecordMatchAliases(record)) {
                const owner = ownerByAlias.get(alias);
                if (owner && owner !== record) {
                    const resolved = resolveCanonical(owner);
                    if (resolved !== record) {
                        canonical = resolved;
                        break;
                    }
                }
            }

            if (canonical) {
                canonicalOf.set(record, canonical);
                duplicates.push({canonical, duplicate: record});
                continue;
            }

            for (const alias of getRecordMatchAliases(record)) {
                if (!ownerByAlias.has(alias)) ownerByAlias.set(alias, record);
            }
        }

        for (const {canonical, duplicate} of duplicates) {
            collapseDuplicateTurnRecord(store, canonical, duplicate);
        }
        return duplicates.length;
    }

    function mergeObservedTurnRecords(
        observedTurns,
        replaceNodeReferences,
        alreadyTracked = false,
        allowBranchReconciliation = false
    ) {
        if (!currentChatIdentity) return;

        const store = getTurnRecordStore(currentChatIdentity);

        reconcileObservedTurnIdentities(observedTurns);

        if (allowBranchReconciliation) {
            const liveIdentities = new Set(observedTurns
                .filter(turn => turn.root?.isConnected)
                .map(turn => turn.identity));
            for (const [identity, suppression] of
                store.suppressedRemovedIdentities
            ) {
                if (
                    suppression.awaitingUnmount &&
                    !liveIdentities.has(identity)
                ) {
                    suppression.awaitingUnmount = false;
                }
            }
        }

        let observed = observedTurns.filter(turn => {
            if (!turn.stableIdentity) return false;

            if (store.suppressedRemovedIdentities.has(turn.identity)) {
                if (
                    !turn.root?.isConnected ||
                    store.suppressedRemovedIdentities.get(
                        turn.identity
                    ).awaitingUnmount
                ) {
                    return false;
                }

                /* A later live remount is allowed to establish the identity again. */
                store.suppressedRemovedIdentities.delete(turn.identity);
            }

            if (
                !store.byIdentity.has(turn.identity) &&
                store.index.isSuppressed(toIndexIdentity(turn))
            ) return false;

            if (turn.kind === 'user' &&
                !Array.isArray(turn.pairedAssistantUnits)) {
                const pairedAssistantUnits = getPairedAssistantUnits(turn);
                turn.pairedAssistantUnits = pairedAssistantUnits;
                turn.pairedAssistantIdentities = pairedAssistantUnits
                    .map(getAssistantUnitIdentity)
                    .filter(Boolean)
                    .map(unitIdentity => `assistant:${unitIdentity}`)
                    .filter(assistantIdentity =>
                        !turnBelongsToAnotherChat(
                            assistantIdentity,
                            currentChatIdentity
                        )
                    );
            }

            return alreadyTracked || trackCurrentRouteTurn(turn);
        });

        const editReconciliation = allowBranchReconciliation
            ? reconcileObservedEdits(store, observed)
            : null;
        const prunedIdentities = editReconciliation?.removedIdentities ||
            new Set();
        if (prunedIdentities.size) {
            observed = observed.filter(turn =>
                !prunedIdentities.has(turn.identity)
            );
        }

        for (const turn of observed) {
            if (turn.kind !== 'user') continue;

            for (const assistantIdentity of turn.pairedAssistantIdentities || []) {
                if (
                    turnBelongsToAnotherChat(
                        assistantIdentity,
                        currentChatIdentity
                    )
                ) {
                    continue;
                }

                const knownUserIdentity =
                    store.pairedAssistantToUser.get(assistantIdentity);
                if (
                    knownUserIdentity &&
                    knownUserIdentity !== turn.identity
                ) {
                    continue;
                }

                store.pairedAssistantToUser.set(
                    assistantIdentity,
                    turn.identity
                );
                removePairedAssistantRecord(
                    store,
                    assistantIdentity,
                    turn.identity
                );
            }
        }

        if (replaceNodeReferences) {
            for (const record of store.turns) {
                record.root = null;
                record.userBubble = null;
                record.assistantUnit = null;
            }
        }

        const newRecords = [];
        for (const turn of observed) {
            let record = store.byIdentity.get(turn.identity);
            if (!record) {
                record = {
                    identity: turn.identity,
                    kind: turn.kind,
                    stableIdentity: true,
                    root: null,
                    userBubble: null,
                    assistantUnit: null,
                    userText: '',
                    userTextSnapshot: '',
                    domUserTextBaseline: null,
                    assistantText: '',
                };
                store.byIdentity.set(turn.identity, record);
                newRecords.push(record);
            }

            record.kind = turn.kind;
            updateTurnRecord(record, turn, replaceNodeReferences);
        }

        if (!store.index.hasSnapshot()) {
            enforceObservedTurnOrder(store.turns, observed);
        }

        for (const record of newRecords) {
            if (
                editReconciliation?.replacementIdentity === record.identity
            ) {
                const insertionIndex = Math.max(
                    0,
                    Math.min(
                        editReconciliation.insertionIndex,
                        store.turns.length
                    )
                );
                store.turns.splice(insertionIndex, 0, record);
            } else {
                insertTurnRecord(store.turns, record, observed);
            }
        }

        collapseDuplicateTurnRecords(store);

        store.index.upsertObserved(store.turns);
        if (store.index.hasSnapshot()) {
            store.turns.splice(0, store.turns.length, ...store.index.getEntries());
        }
    }

    function buildRenderedTurns(observedTurns) {
        const store = getTurnRecordStore(currentChatIdentity);
        const entries = store.index.getEntries();
        const rendered = [...entries];
        const placements = [];

        if (!rendered.length) {
            return observedTurns.filter(turn => !turn.stableIdentity);
        }

        observedTurns.forEach((turn, observedIndex) => {
            if (turn.stableIdentity) return;

            let insertionIndex = -1;

            for (let index = observedIndex - 1; index >= 0; index--) {
                const anchorIndex = rendered.findIndex(record =>
                    record.identity === observedTurns[index].identity
                );
                if (anchorIndex >= 0) {
                    insertionIndex = anchorIndex + 1;
                    break;
                }
            }

            if (insertionIndex < 0) {
                for (let index = observedIndex + 1; index < observedTurns.length; index++) {
                    const anchorIndex = rendered.findIndex(record =>
                        record.identity === observedTurns[index].identity
                    );
                    if (anchorIndex >= 0) {
                        insertionIndex = anchorIndex;
                        break;
                    }
                }
            }

            if (insertionIndex < 0) insertionIndex = rendered.length;
            placements.push({ turn, insertionIndex, observedIndex });
        });

        placements.sort((a, b) =>
            a.insertionIndex - b.insertionIndex ||
            a.observedIndex - b.observedIndex
        );

        placements.forEach(({ turn, insertionIndex }, index) => {
            rendered.splice(insertionIndex + index, 0, turn);
        });

        return rendered;
    }

    function getTurnBarLabel(turn, index, contentTurn = turn) {
        const isAssistant = turn.kind === 'assistant';
        const liveText = isAssistant
            ? getAssistantText(contentTurn)
            : getUserText(contentTurn);
        const text = liveText || (isAssistant
            ? turn.assistantTextSource === 'native-complete'
                ? ''
                : turn.assistantText || ''
            : turn.userText || '');
        const label = shorten(text.replace(/\n/g, ' '), 42);
        const description = isAssistant
            ? `第 ${index + 1} 条 ChatGPT 回复`
            : `第 ${index + 1} 轮对话`;

        return `${description}${label ? `：${label}` : ''}`;
    }


    /******************************************************************
     * Hover Preview
     ******************************************************************/

    function showPreview(index, bar) {
        clearTimeout(hideTimer);

        const turn = turns[index];
        if (!turn) return;

        const assistantOnly = turn.kind === 'assistant';
        let userText = getUserText(turn);
        let assistantText = getAssistantText(turn);

        preview.classList.toggle('yw-assistant-only', assistantOnly);

        if (!assistantOnly && !userText) {
            userText = '（用户消息尚未加载）';
        }

        if (!assistantText) {
            assistantText = '（ChatGPT 回复尚未加载或仍在生成）';
        }

        previewUser.textContent = userText;
        previewAssistant.textContent = assistantText;

        /*
         * 先隐藏着测量尺寸，
         * 避免 tooltip 先闪一下再移动。
         */
        preview.style.visibility = 'hidden';
        preview.classList.add('yw-visible');

        requestAnimationFrame(() => {
            const barRect = bar.getBoundingClientRect();

            const cardHeight = preview.offsetHeight;

            let top =
                barRect.top +
                barRect.height / 2 -
                cardHeight / 2;

            const padding = 12;

            top = Math.max(
                padding,
                Math.min(
                    window.innerHeight - cardHeight - padding,
                    top
                )
            );

            preview.style.top = `${top}px`;

            /*
             * 移除 inline hidden，
             * 重新交给 .yw-visible 控制。
             */
            preview.style.visibility = '';
        });
    }

    function hidePreviewSoon() {
        clearTimeout(hideTimer);

        hideTimer = setTimeout(() => {
            preview?.classList.remove('yw-visible');
        }, 70);
    }


    /******************************************************************
     * 点击：滚动到相应 turn
     ******************************************************************/

    function clearExtendedScrollRange() {
        if (!extendedScrollRange) return;

        const {
            container,
            originalValue,
            originalPriority,
            appliedValue
        } = extendedScrollRange;
        const currentValue = container.style.getPropertyValue('padding-bottom');
        const currentPriority = container.style.getPropertyPriority('padding-bottom');

        if (
            currentValue === appliedValue &&
            currentPriority === 'important'
        ) {
            if (originalValue) {
                container.style.setProperty(
                    'padding-bottom',
                    originalValue,
                    originalPriority
                );
            } else {
                container.style.removeProperty('padding-bottom');
            }
        }

        extendedScrollRange = null;
    }

    function extendScrollRangeTo(scrollContext, desiredTop) {
        const { container } = scrollContext;
        const maxScrollTop = scrollContext.maxTop();
        const requiredExtension = getRequiredScrollExtension(
            desiredTop,
            maxScrollTop
        );
        if (!requiredExtension) return maxScrollTop;

        const originalValue = container.style.getPropertyValue('padding-bottom');
        const originalPriority = container.style.getPropertyPriority('padding-bottom');
        const computedPadding = parseFloat(
            window.getComputedStyle(container).paddingBottom
        ) || 0;
        const appliedPadding = computedPadding + requiredExtension + 2;

        container.style.setProperty(
            'padding-bottom',
            appliedPadding + 'px',
            'important'
        );
        extendedScrollRange = {
            container,
            originalValue,
            originalPriority,
            appliedValue: appliedPadding + 'px'
        };
        return scrollContext.maxTop();
    }

    function observeUserScrollIntent() {
        const isEditable = target => Boolean(
            target instanceof Element &&
            target.closest(INLINE_USER_EDITOR_SELECTOR)
        );
        const renewAnchorCapture = () => {
            pendingUserScrollAnchor = true;
            if (pendingUserScrollAnchorFrame !== null) {
                cancelAnimationFrame(pendingUserScrollAnchorFrame);
            }
            const generation = userScrollGeneration;
            pendingUserScrollAnchorFrame = requestAnimationFrame(() => {
                if (generation !== userScrollGeneration) return;
                pendingUserScrollAnchor = false;
                pendingUserScrollAnchorFrame = null;
            });
        };

        for (const eventName of [
            'wheel', 'touchstart', 'touchmove', 'pointerdown', 'pointermove', 'keydown'
        ]) {
            const target = eventName === 'keydown' ? window : document;
            target.addEventListener(eventName, event => {
                const eventElement = asElement(event.target);
                if (
                    (eventElement && rail?.contains(eventElement)) ||
                    (eventElement &&
                        replyNavigationUI?.root?.contains(eventElement))
                ) return;
                if (eventName === 'pointermove' && event.buttons === 0) return;
                if (eventName === 'keydown') {
                    if (isEditable(event.target)) return;
                    if (![
                        'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown',
                        'Home', 'End', ' '
                    ].includes(event.key)) {
                        return;
                    }
                }
                userScrollGeneration += 1;
                assistantReplyNavigationCursor = null;
                renewAnchorCapture();
                cancelJumpSearch();
                clearExtendedScrollRange();
                requestAnimationFrame(updateReplyTopButton);
            }, true);
        }
    }

    function findScrollContainer(target) {
        for (
            let ancestor = target.parentElement;
            ancestor && ancestor !== document.body;
            ancestor = ancestor.parentElement
        ) {
            const style = window.getComputedStyle(ancestor);
            const canScroll = /^(auto|scroll|overlay|hidden)$/.test(style.overflowY);
            const hasScrollableExtent =
                ancestor.scrollHeight > ancestor.clientHeight + 1;
            if (canScroll && ancestor.clientHeight > 0 && hasScrollableExtent) {
                return ancestor;
            }
        }
        return document.scrollingElement || document.documentElement;
    }

    function cancelJumpSearch() {
        if (activeJumpSearch) {
            activeJumpSearch.cancelled = true;
            if (activeJumpSearch.correctionFrame !== null) {
                cancelAnimationFrame(activeJumpSearch.correctionFrame);
            }
            activeJumpSearch = null;
        }
        if (scrollCoordinatorResizeObserver) {
            scrollCoordinatorResizeObserver.disconnect();
            scrollCoordinatorResizeObserver = null;
        }
        clearExtendedScrollRange();
    }

    function isCurrentJumpSearch(search) {
        const currentEntry = search?.messageId
            ? getCurrentEntry(search.identity)
            : null;
        return Boolean(
            search &&
            activeJumpSearch === search &&
            !search.cancelled &&
            search.userScrollGeneration === userScrollGeneration &&
            currentChatIdentity === search.chatIdentity &&
            getChatIdentity() === search.chatIdentity &&
            (
                turns.some(turn => turn.identity === search.identity) ||
                getConversationIndex(search.chatIdentity)
                    .getEntries()
                    .some(entry => entry.identity === search.identity)
            ) &&
            (!search.messageId || entryContainsMessage(currentEntry, search.messageId))
        );
    }

    function waitForAnimationFrame() {
        return new Promise(resolve => requestAnimationFrame(resolve));
    }

    function getScrollTop(container, isDocumentScroll) {
        return isDocumentScroll
            ? (window.scrollY || container.scrollTop)
            : container.scrollTop;
    }

    function setScrollTop(container, isDocumentScroll, value) {
        container.scrollTop = value;
        if (isDocumentScroll && window.scrollY !== value) {
            window.scrollTo(0, value);
        }
    }

    function createScrollContext(target) {
        const container = findScrollContainer(target);
        const isDocumentScroll =
            container === document.scrollingElement ||
            container === document.documentElement ||
            container === document.body;
        const containerStyle = isDocumentScroll
            ? null
            : window.getComputedStyle(container);
        const isReverseFlexScroll = Boolean(
            containerStyle &&
            (containerStyle.display === 'flex' ||
                containerStyle.display === 'inline-flex') &&
            containerStyle.flexDirection === 'column-reverse'
        );
        const maxTop = () => Math.max(
            0,
            container.scrollHeight - container.clientHeight
        );

        return {
            container,
            isDocumentScroll,
            get viewportTop() {
                return isDocumentScroll
                    ? 0
                    : container.getBoundingClientRect().top + container.clientTop;
            },
            getTop: () => {
                const rawTop = getScrollTop(container, isDocumentScroll);
                return isReverseFlexScroll ? rawTop + maxTop() : rawTop;
            },
            setTop: value => {
                const currentMaxTop = maxTop();
                const boundedTop = Math.max(0, Math.min(currentMaxTop, value));
                const rawTop = isReverseFlexScroll
                    ? boundedTop - currentMaxTop
                    : boundedTop;
                setScrollTop(container, isDocumentScroll, rawTop);
                return boundedTop;
            },
            maxTop
        };
    }

    function getFixedHeaderInset(target, scrollContext) {
        const viewportTop = getScrollViewportGeometry(
            scrollContext,
            target
        ).top;
        const targetRect = target.getBoundingClientRect();
        const targetX = targetRect.left + targetRect.width / 2;
        let inset = 0;

        for (const element of document.querySelectorAll(
            'header, [role="banner"], [data-testid*="header"]'
        )) {
            const position = window.getComputedStyle(element).position;
            if (position !== 'fixed' && position !== 'sticky') continue;

            const rect = element.getBoundingClientRect();
            if (
                rect.left <= targetX && rect.right > targetX &&
                rect.top <= viewportTop + 2 && rect.bottom > viewportTop
            ) {
                inset = Math.max(inset, rect.bottom - viewportTop);
            }
        }
        return inset > 0 ? Math.ceil(inset + 8) : 0;
    }

    function getScrollViewportGeometry(scrollContext, target = null) {
        if (scrollContext.isDocumentScroll) {
            let left = 0;
            let right = window.innerWidth;
            const main = target?.closest?.('main, [role="main"]');
            if (main?.isConnected) {
                const mainRect = main.getBoundingClientRect();
                if (mainRect.width > 0 && mainRect.right > mainRect.left) {
                    left = Math.max(0, mainRect.left);
                    right = Math.min(window.innerWidth, mainRect.right);
                }
            }
            return clipReplyScrollViewportGeometry({
                left,
                right,
                top: scrollContext.viewportTop,
                bottom: scrollContext.viewportTop + window.innerHeight
            }, window.innerWidth, window.innerHeight);
        }

        const container = scrollContext.container;
        const rect = container.getBoundingClientRect();
        const left = rect.left + container.clientLeft;
        return clipReplyScrollViewportGeometry({
            left,
            right: left + container.clientWidth,
            top: scrollContext.viewportTop,
            bottom: scrollContext.viewportTop + container.clientHeight
        }, window.innerWidth, window.innerHeight);
    }

    function isReplyLayoutElementVisible(element) {
        if (!element?.isConnected || element.closest('[hidden]')) return false;
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' &&
            rect.width > 0 && rect.height > 0;
    }

    function getPromptComposerRoot() {
        const selectors = [
            '#prompt-textarea',
            '[data-testid="prompt-textarea"]',
            '[data-testid="composer-text-input"]',
            'form textarea, form [contenteditable="true"], ' +
                'form [contenteditable=""]'
        ];
        let control = null;
        for (const selector of selectors) {
            const candidate = document.querySelector(selector);
            if (isReplyLayoutElementVisible(candidate)) {
                control = candidate;
                break;
            }
        }
        if (!control) {
            const composer = document.querySelector('[data-testid*="composer"]');
            if (isReplyLayoutElementVisible(composer)) return composer;
            return null;
        }
        return control.closest('form') ||
            control.closest('[data-testid*="composer"]') || control;
    }

    function getFixedBottomInset(target, scrollContext) {
        const viewport = getScrollViewportGeometry(scrollContext, target);
        const targetRect = target.getBoundingClientRect();
        const targetX = targetRect.left + targetRect.width / 2;
        const excludesReplyOrScroller = element =>
            element === target || element.contains(target) ||
            element.contains(scrollContext.container);
        const positionOf = element =>
            window.getComputedStyle(element).position;
        const composerRoot = getPromptComposerRoot();
        const composerOverlays = composerRoot
            ? collectFixedPositionAncestors(
                [composerRoot],
                scrollContext.container,
                document.body,
                positionOf,
                excludesReplyOrScroller,
                ['fixed', 'sticky', 'absolute']
            ).map(element => ({
                element,
                kind: 'composer',
                position: positionOf(element),
                rect: element.getBoundingClientRect()
            }))
            : [];
        const edgeCandidates = document.querySelectorAll(
            'footer, [role="contentinfo"], ' +
            '[data-testid*="footer"], [data-testid*="bottom"]'
        );
        const composerElements = new Set(
            composerOverlays.map(overlay => overlay.element)
        );
        const edgeOverlays = collectFixedPositionAncestors(
            edgeCandidates,
            scrollContext.container,
            document.body,
            positionOf,
            excludesReplyOrScroller
        ).filter(element => !composerElements.has(element)).map(element => ({
            kind: 'edge',
            position: positionOf(element),
            rect: element.getBoundingClientRect()
        }));
        const overlayGeometry = composerOverlays.map(overlay => ({
            kind: overlay.kind,
            position: overlay.position,
            rect: overlay.rect
        }));
        return computeBottomOverlayInset(
            [...overlayGeometry, ...edgeOverlays],
            viewport,
            targetX,
            targetRect
        );
    }

    function findMessageElement(messageId) {
        if (!messageId) return null;
        for (const element of document.querySelectorAll(
            '[data-chatgpt-selection-message-id]'
        )) {
            if (
                element.getAttribute('data-chatgpt-selection-message-id') ===
                messageId
            ) {
                return element;
            }
        }
        for (const element of document.querySelectorAll(
            USER_MESSAGE_ID_SELECTOR
        )) {
            const ids = getMessageIds(
                element.getAttribute('data-chatgpt-search-message-ids') ||
                element.getAttribute('data-message-id') ||
                ''
            );
            if (ids.includes(messageId)) return element;
        }
        for (const unit of document.querySelectorAll(ASSISTANT_UNIT_SELECTOR)) {
            const target = findAssistantMessageTarget(unit, messageId);
            if (target) return target;
        }
        return null;
    }

    function findMountedTurn(identity) {
        const direct = mountedTurnsByIdentity.get(identity);
        if (direct?.root?.isConnected) return direct;

        const entry = turns.find(turn => turn.identity === identity);
        if (entry?.root?.isConnected) return entry;
        return null;
    }

    function getEntryUserMessageId(entry) {
        if (entry?.userMessageId) return entry.userMessageId;
        if (entry?.userMessageIds?.[0]) return entry.userMessageIds[0];
        if (entry?.kind === 'assistant') return '';
        const mounted = findMountedTurn(entry?.identity);
        return getTurnMessageIds(mounted).userMessageId || '';
    }

    function getEntryAssistantMessageId(entry) {
        return entry?.kind === 'assistant'
            ? (entry.messageId || entry.assistantMessageIds?.[0] || '')
            : (entry?.assistantMessageIds?.[0] || '');
    }

    function getAssistantReplyTarget(turn) {
        if (!turn) return null;
        const assistantUnit = turn.kind === 'user'
            ? getPairedAssistantUnits(turn)[0] || turn.assistantUnit
            : turn.assistantUnit || turn.root;
        if (!assistantUnit?.isConnected) return null;
        return assistantUnit.querySelector(
            '[data-chatgpt-selection-message-id]'
        ) || assistantUnit;
    }

    function getEntryTargetMessageId(entry, options = {}) {
        if (options.replyTop) return getEntryAssistantMessageId(entry);
        if (entry?.kind === 'assistant') return getEntryAssistantMessageId(entry);
        return getEntryUserMessageId(entry);
    }

    function findMountedMessageForEntry(entry, messageId) {
        if (!entry || !messageId) return null;

        const mounted = findMountedTurn(entry.identity);
        if (!mounted) return findMessageElement(messageId);

        const userMessageIds = [
            entry.userMessageId,
            ...(Array.isArray(entry.userMessageIds) ? entry.userMessageIds : [])
        ].filter(Boolean);
        if (
            entry.kind === 'user' &&
            userMessageIds.includes(messageId) &&
            mounted.userBubble?.isConnected
        ) {
            return mounted.userBubble;
        }

        const message = findMessageElement(messageId);
        if (message?.isConnected) return message;

        const assistantMessageIds = Array.isArray(entry.assistantMessageIds)
            ? entry.assistantMessageIds
            : [];
        if (!assistantMessageIds.includes(messageId)) return null;

        const assistantUnits = entry.kind === 'user'
            ? getPairedAssistantUnits(mounted)
            : [mounted.assistantUnit || mounted.root].filter(Boolean);
        for (const unit of assistantUnits) {
            const target = findAssistantMessageTarget(unit, messageId);
            if (target) return target;
        }
        return null;
    }

    function findCurrentEntryForMessage(messageId) {
        if (!messageId) return null;
        return turns.find(entry => entryContainsMessage(entry, messageId)) ||
            getConversationIndex(currentChatIdentity)
                .getEntries()
                .find(entry => entryContainsMessage(entry, messageId)) || null;
    }

    function findReadingAnchorTarget(anchor) {
        if (!anchor) return null;
        const entry = anchor.identity
            ? getCurrentEntry(anchor.identity)
            : findCurrentEntryForMessage(anchor.messageId);
        if (anchor.messageId) {
            return findMountedMessageForEntry(entry, anchor.messageId) ||
                findMessageElement(anchor.messageId);
        }
        return getMountedTarget(entry);
    }

    function getMountedTarget(entry, options = {}) {
        const turn = findMountedTurn(entry?.identity);
        if (!turn) return null;
        if (options.replyTop) return getAssistantReplyTarget(turn);
        if (entry.kind === 'user') {
            return turn.userBubble?.isConnected ? turn.userBubble : turn.root;
        }
        return turn.root?.querySelector?.(
            '[data-chatgpt-selection-message-id]'
        ) || turn.root;
    }

    function entryContainsMessage(entry, messageId) {
        if (!entry || !messageId) return false;
        return entry.messageId === messageId ||
            entry.userMessageId === messageId ||
            (entry.userMessageIds || []).includes(messageId) ||
            (entry.assistantMessageIds || []).includes(messageId);
    }

    function getCurrentEntry(identity) {
        const current = turns.find(turn => turn.identity === identity);
        if (current) return current;
        return getConversationIndex(currentChatIdentity)
            .getEntries()
            .find(entry => entry.identity === identity) || null;
    }

    function resolveSearchTarget(search) {
        if (!isCurrentJumpSearch(search)) return null;
        const entry = getCurrentEntry(search.identity);
        if (!entry) return null;

        if (search.messageId) {
            if (!entryContainsMessage(entry, search.messageId)) return null;
            return findMountedMessageForEntry(entry, search.messageId);
        }
        return getMountedTarget(entry, search.options);
    }

    function correctForegroundTarget(search) {
        const target = resolveSearchTarget(search);
        if (!target?.isConnected || !isCurrentJumpSearch(search)) return null;

        const context = createScrollContext(target);
        const headerInset = getFixedHeaderInset(target, context);
        const targetTop = context.getTop() +
            target.getBoundingClientRect().top - context.viewportTop -
            headerInset;
        extendScrollRangeTo(context, Math.max(0, targetTop));
        context.setTop(Math.max(0, targetTop));

        search.target = target;
        search.scrollContext = context;
        search.headerInset = headerInset;
        search.lastGeometry =
            target.getBoundingClientRect().top - context.viewportTop;
        return target;
    }

    function scheduleForegroundCorrection(search = activeJumpSearch) {
        if (
            !search ||
            search.correctionFrame !== null ||
            !isCurrentJumpSearch(search)
        ) {
            return;
        }
        search.correctionFrame = requestAnimationFrame(() => {
            search.correctionFrame = null;
            correctForegroundTarget(search);
        });
    }

    function installCoordinatorObservers(search, target) {
        if (typeof ResizeObserver !== 'function') return;
        const container = search.scrollContext?.container;
        const threadRoot = target.closest('main') || target.parentElement;
        const nodes = [target];
        if (container instanceof Element && container !== target) {
            nodes.push(container);
        }
        if (
            threadRoot instanceof Element &&
            threadRoot.isConnected &&
            !nodes.includes(threadRoot)
        ) {
            nodes.push(threadRoot);
        }

        if (
            search.observedResizeNodes &&
            nodes.length === search.observedResizeNodes.length &&
            nodes.every((node, index) => node === search.observedResizeNodes[index]) &&
            scrollCoordinatorResizeObserver
        ) {
            return;
        }
        if (scrollCoordinatorResizeObserver) {
            scrollCoordinatorResizeObserver.disconnect();
        }
        const observer = new ResizeObserver(() =>
            scheduleForegroundCorrection(search)
        );
        scrollCoordinatorResizeObserver = observer;
        search.observedResizeNodes = nodes;
        for (const node of nodes) observer.observe(node);
    }

    function clearForegroundSearch(search) {
        if (activeJumpSearch !== search) return;
        search.cancelled = true;
        if (search.correctionFrame !== null) {
            cancelAnimationFrame(search.correctionFrame);
        }
        activeJumpSearch = null;
        if (scrollCoordinatorResizeObserver) {
            scrollCoordinatorResizeObserver.disconnect();
            scrollCoordinatorResizeObserver = null;
        }
        clearExtendedScrollRange();
    }

    async function waitForMountedMessage(search, messageId, timeoutMs = 1200) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (!isCurrentJumpSearch(search)) return null;
            const target = findMountedMessageForEntry(
                getCurrentEntry(search.identity),
                messageId
            );
            if (target?.isConnected) return target;
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        return null;
    }

    function getDOMSearchEstimate(search) {
        const targetIndex = turns.findIndex(turn => turn.identity === search.identity);
        if (targetIndex < 0) return null;

        const mounted = [];
        for (let index = 0; index < turns.length; index += 1) {
            const turn = turns[index];
            const element = getMountedTarget(turn);
            if (!element?.isConnected) continue;
            const context = createScrollContext(element);
            const top = context.getTop() +
                element.getBoundingClientRect().top - context.viewportTop;
            mounted.push({index, element, context, top});
        }
        if (!mounted.length) return null;

        mounted.sort((left, right) => left.index - right.index);
        const anchor = mounted.reduce((best, candidate) =>
            Math.abs(candidate.index - targetIndex) < Math.abs(best.index - targetIndex)
                ? candidate
                : best
        );
        const neighbors = mounted.filter(candidate =>
            candidate.context.container === anchor.context.container &&
            Math.abs(candidate.index - anchor.index) <= 40
        );
        const spacings = [];
        for (let index = 1; index < neighbors.length; index += 1) {
            const previous = neighbors[index - 1];
            const next = neighbors[index];
            const turnDistance = next.index - previous.index;
            if (turnDistance <= 0) continue;
            const spacing = Math.abs(next.top - previous.top) / turnDistance;
            if (Number.isFinite(spacing) && spacing > 0) spacings.push(spacing);
        }
        spacings.sort((left, right) => left - right);
        const viewportHeight = anchor.context.isDocumentScroll
            ? window.innerHeight
            : anchor.context.container.clientHeight;
        const typicalTurnHeight = spacings.length
            ? spacings[Math.floor(spacings.length / 2)]
            : Math.max(160, viewportHeight * 0.75);
        const stepSize = Math.max(120, Math.min(viewportHeight * 1.5, typicalTurnHeight));
        const estimateTop = Math.max(0, Math.min(
            anchor.context.maxTop(),
            anchor.top + (targetIndex - anchor.index) * typicalTurnHeight
        ));

        return {
            context: anchor.context,
            estimateTop,
            stepSize,
            initialDirection: targetIndex >= anchor.index ? 1 : -1
        };
    }

    async function runDOMSearchFallback(search) {
        const estimate = getDOMSearchEstimate(search);
        if (!estimate) {
            return {target: null, reason: 'NO_MOUNTED_SCROLL_ANCHOR', steps: 0};
        }

        const result = await runBoundedScrollSearch({
            ...estimate,
            maxSteps: 24,
            timeoutMs: 8000,
            maxNoProgress: 2,
            getTop: () => estimate.context.getTop(),
            setTop: value => estimate.context.setTop(value),
            findTarget: () => resolveSearchTarget(search),
            isCurrent: () => isCurrentJumpSearch(search),
            waitForStep: () => new Promise(resolve => setTimeout(resolve, 140))
        });
        if (!result.target && isCurrentJumpSearch(search)) {
            estimate.context.setTop(result.originalTop);
        }
        return result;
    }

    async function waitForForegroundSettle(search) {
        const deadline = Date.now() + 15000;
        let previousGeometry = null;
        let stableFrames = 0;
        while (Date.now() < deadline && isCurrentJumpSearch(search)) {
            const target = correctForegroundTarget(search);
            if (!target) {
                await new Promise(resolve => setTimeout(resolve, 40));
                continue;
            }
            installCoordinatorObservers(search, target);
            await waitForAnimationFrame();
            if (!isCurrentJumpSearch(search)) return false;
            const context = search.scrollContext;
            const geometry =
                target.getBoundingClientRect().top - context.viewportTop;
            if (
                previousGeometry !== null &&
                Math.abs(geometry - previousGeometry) <= 0.75
            ) {
                stableFrames += 1;
            } else {
                stableFrames = 0;
            }
            previousGeometry = geometry;
            if (stableFrames >= 3) {
                const index = turns.findIndex(turn =>
                    turn.identity === search.identity
                );
                if (index >= 0) setActive(index);
                search.settled = true;
                return true;
            }
        }
        return false;
    }

    async function jumpToIdentity(identity, explicitMessageId = '', options = {}) {
        const entry = getCurrentEntry(identity);
        if (!entry) return;

        cancelJumpSearch();
        const search = {
            chatIdentity: currentChatIdentity,
            identity,
            messageId: explicitMessageId ||
                getEntryTargetMessageId(entry, options),
            options,
            cancelled: false,
            userScrollGeneration,
            correctionFrame: null,
            settled: false
        };
        activeJumpSearch = search;

        try {
            let target = search.messageId
                ? findMountedMessageForEntry(entry, search.messageId)
                : getMountedTarget(entry, options);

            if (search.messageId && !entryContainsMessage(entry, search.messageId)) {
                console.warn('[Conversation Navigator] Jump failed (TARGET_MESSAGE_NOT_IN_ENTRY)');
                clearForegroundSearch(search);
                return;
            }

            if (!target && search.messageId) {
                let fallbackReason = 'locator-unavailable';
                const locator = nativeLocator;
                const locatorEpoch = nativeLocatorEpoch;
                if (locator) {
                    try {
                        const located = await locator.locateMessage(
                            search.messageId,
                            () => isCurrentJumpSearch(search)
                        );
                        if (!isCurrentJumpSearch(search)) {
                            clearForegroundSearch(search);
                            return;
                        }
                        fallbackReason = located
                            ? 'native-target-not-mounted'
                            : 'message-not-in-native-entries';
                        if (located) {
                            target = await waitForMountedMessage(search, search.messageId);
                        }
                    } catch (error) {
                        fallbackReason = getDiagnosticCode(error, 'NATIVE_LOCATOR_FAILED');
                    }
                    if (locator !== nativeLocator || locatorEpoch !== nativeLocatorEpoch) {
                        target = null;
                    }
                } else if (nativeLocatorError) {
                    fallbackReason = getDiagnosticCode(nativeLocatorError, 'NATIVE_LOCATOR_UNAVAILABLE');
                }

                if (!target && isCurrentJumpSearch(search)) {
                    console.info(`[Conversation Navigator] Jump using bounded DOM search (${fallbackReason})`);
                    const fallback = await runDOMSearchFallback(search);
                    if (!isCurrentJumpSearch(search)) {
                        clearForegroundSearch(search);
                        return;
                    }
                    target = fallback.target;
                    if (!target) {
                        console.warn(`[Conversation Navigator] Jump failed (${fallback.reason})`);
                        clearForegroundSearch(search);
                        return;
                    }
                    console.info(`[Conversation Navigator] Jump fallback completed (${fallback.steps} steps)`);
                }
            }
            if (!target?.isConnected || !isCurrentJumpSearch(search)) {
                if (isCurrentJumpSearch(search)) {
                    console.warn('[Conversation Navigator] Jump failed (TARGET_NOT_MOUNTED)');
                }
                clearForegroundSearch(search);
                return;
            }

            search.target = target;
            search.scrollContext = createScrollContext(target);
            installCoordinatorObservers(search, target);
            const settled = await waitForForegroundSettle(search);
            if (!settled) clearForegroundSearch(search);
            updateReplyTopButton();
        } catch (error) {
            if (isCurrentJumpSearch(search)) {
                console.warn(`[Conversation Navigator] Jump failed (${getDiagnosticCode(error, 'NAVIGATION_FAILED')})`);
                clearForegroundSearch(search);
            }
        }
    }

    function getVisibleReadingAnchor() {
        const chatIdentity = currentChatIdentity;
        const generation = userScrollGeneration;
        const foreground = activeJumpSearch;
        if (
            foreground &&
            isCurrentJumpSearch(foreground) &&
            foreground.messageId
        ) {
            const element = findMountedMessageForEntry(
                getCurrentEntry(foreground.identity),
                foreground.messageId
            );
            if (element?.isConnected) {
                const context = createScrollContext(element);
                return {
                    chatIdentity,
                    identity: foreground.identity,
                    userScrollGeneration: generation,
                    messageId: foreground.messageId,
                    offset: element.getBoundingClientRect().top - context.viewportTop
                };
            }
        }

        const candidates = [];
        for (const element of document.querySelectorAll(MESSAGE_ELEMENT_SELECTOR)) {
            if (!element.isConnected) continue;
            const ids = element.hasAttribute('data-chatgpt-selection-message-id')
                ? [element.getAttribute('data-chatgpt-selection-message-id')]
                : getMessageIds(
                    element.getAttribute('data-chatgpt-search-message-ids') ||
                    element.getAttribute('data-message-id') ||
                    ''
                );
            const messageId = ids.find(Boolean);
            if (!messageId) continue;
            const rect = element.getBoundingClientRect();
            const context = createScrollContext(element);
            const viewportHeight = context.isDocumentScroll
                ? window.innerHeight
                : context.container.clientHeight;
            const readingY = context.viewportTop + viewportHeight * 0.38;
            if (
                rect.bottom <= context.viewportTop ||
                rect.top >= context.viewportTop + viewportHeight
            ) {
                continue;
            }
            const entry = findCurrentEntryForMessage(messageId);
            candidates.push({
                element,
                messageId,
                identity: entry?.identity || '',
                rect,
                context,
                readingY
            });
        }

        for (const [identity, mounted] of mountedTurnsByIdentity) {
            if (!mounted.userBubble?.isConnected) continue;
            const entry = getCurrentEntry(identity);
            if (entry?.kind !== 'user') continue;
            const messageId = getEntryUserMessageId(entry);
            const alreadyAdded = candidates.some(candidate =>
                candidate.element === mounted.userBubble &&
                (!messageId || candidate.messageId === messageId)
            );
            if (alreadyAdded) continue;

            const rect = mounted.userBubble.getBoundingClientRect();
            const context = createScrollContext(mounted.userBubble);
            const viewportHeight = context.isDocumentScroll
                ? window.innerHeight
                : context.container.clientHeight;
            const readingY = context.viewportTop + viewportHeight * 0.38;
            if (
                rect.bottom <= context.viewportTop ||
                rect.top >= context.viewportTop + viewportHeight
            ) {
                continue;
            }
            candidates.push({
                element: mounted.userBubble,
                messageId,
                identity,
                rect,
                context,
                readingY
            });
        }
        if (!candidates.length) return null;

        candidates.sort((left, right) => {
            const distance = candidate => candidate.readingY < candidate.rect.top
                ? candidate.rect.top - candidate.readingY
                : (candidate.readingY > candidate.rect.bottom
                    ? candidate.readingY - candidate.rect.bottom
                    : 0);
            return distance(left) - distance(right);
        });
        const anchor = candidates[0];
        return {
            chatIdentity,
            identity: anchor.identity,
            userScrollGeneration: generation,
            messageId: anchor.messageId,
            offset: anchor.rect.top - anchor.context.viewportTop
        };
    }

    function captureHistoryAnchorAfterUserScroll() {
        if (!pendingUserScrollAnchor) return;
        pendingUserScrollAnchor = false;
        if (pendingUserScrollAnchorFrame !== null) {
            cancelAnimationFrame(pendingUserScrollAnchorFrame);
            pendingUserScrollAnchorFrame = null;
        }
        if (!activeHistoryAnchor) return;
        const latest = getVisibleReadingAnchor();
        if (latest) Object.assign(activeHistoryAnchor, latest);
    }

    async function waitForReadingAnchorTarget(anchor, locatorEpoch, timeoutMs = 1200) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (
                anchor.chatIdentity !== currentChatIdentity ||
                anchor.userScrollGeneration !== userScrollGeneration ||
                locatorEpoch !== nativeLocatorEpoch
            ) {
                return null;
            }
            const target = findReadingAnchorTarget(anchor);
            if (target?.isConnected) return target;
            await new Promise(resolve => setTimeout(resolve, 40));
        }
        return null;
    }

    async function restoreReadingAnchor(anchor) {
        if (
            !anchor ||
            anchor.chatIdentity !== currentChatIdentity ||
            anchor.userScrollGeneration !== userScrollGeneration
        ) {
            return false;
        }
        await waitForAnimationFrame();
        await waitForAnimationFrame();
        if (
            anchor.chatIdentity !== currentChatIdentity ||
            anchor.userScrollGeneration !== userScrollGeneration
        ) {
            return false;
        }

        let target = findReadingAnchorTarget(anchor);
        if (!target && nativeLocator && anchor.messageId) {
            const locator = nativeLocator;
            const locatorEpoch = nativeLocatorEpoch;
            try {
                const located = await locator.locateMessage(anchor.messageId, () =>
                    anchor.chatIdentity === currentChatIdentity &&
                    anchor.userScrollGeneration === userScrollGeneration &&
                    locator === nativeLocator &&
                    locatorEpoch === nativeLocatorEpoch
                );
                if (
                    !located ||
                    locator !== nativeLocator ||
                    locatorEpoch !== nativeLocatorEpoch
                ) {
                    return false;
                }
                target = await waitForReadingAnchorTarget(anchor, locatorEpoch);
            } catch (_error) {
                return false;
            }
        }
        if (!target?.isConnected) return false;

        const context = createScrollContext(target);
        const currentOffset = target.getBoundingClientRect().top -
            context.viewportTop;
        const residual = currentOffset - anchor.offset;
        if (Math.abs(residual) > 1) {
            context.setTop(context.getTop() + residual);
        }
        scheduleForegroundCorrection();
        return true;
    }

    function invalidateThreadLayout() {
        scheduleForegroundCorrection();
        requestAnimationFrame(updateReplyTopButton);
    }

    function scheduleReplyNavigationUpdate() {
        if (replyNavigationRAF !== null) return;
        replyNavigationRAF = requestAnimationFrame(() => {
            replyNavigationRAF = null;
            updateReplyTopButton();
        });
    }

    function disconnectReplyNavigationLayoutObservers() {
        if (replyLayoutResizeObserver) {
            replyLayoutResizeObserver.disconnect();
            replyLayoutResizeObserver = null;
        }
        replyLayoutObservedNodes.clear();
        replyLayoutObservedSidebar?.removeEventListener(
            'transitionend',
            handleReplySidebarTransitionEnd
        );
        replyLayoutObservedSidebar = null;
    }

    function handleReplySidebarTransitionEnd(event) {
        if (
            event.target === replyLayoutObservedSidebar &&
            (!event.propertyName ||
                /width|transform|margin|flex-basis/.test(event.propertyName))
        ) {
            scheduleReplyNavigationUpdate();
        }
    }

    function syncReplyNavigationLayoutObservers(context) {
        if (!replyNavigationUI?.root?.isConnected) {
            disconnectReplyNavigationLayoutObservers();
            return;
        }
        const sidebar = getReplySidebarElement();
        if (sidebar !== replyLayoutObservedSidebar) {
            replyLayoutObservedSidebar?.removeEventListener(
                'transitionend',
                handleReplySidebarTransitionEnd
            );
            replyLayoutObservedSidebar = sidebar?.isConnected ? sidebar : null;
            replyLayoutObservedSidebar?.addEventListener(
                'transitionend',
                handleReplySidebarTransitionEnd
            );
        }
        if (typeof ResizeObserver !== 'function') return;
        if (!replyLayoutResizeObserver) {
            replyLayoutResizeObserver = new ResizeObserver(() => {
                if (!replyNavigationUI?.root?.isConnected) {
                    disconnectReplyNavigationLayoutObservers();
                    return;
                }
                scheduleReplyNavigationUpdate();
            });
        }

        const main = context?.reply?.closest('main, [role="main"]');
        const nextNodes = new Set(
            [
                sidebar,
                main,
                context?.scrollContext?.container,
                document.getElementById(RAIL_ID),
                getReplyThreadContentLayout(context),
                replyNavigationUI?.outline
            ].filter(node =>
                node instanceof Element && node.isConnected
            )
        );
        for (const node of replyLayoutObservedNodes) {
            if (nextNodes.has(node)) continue;
            replyLayoutResizeObserver.unobserve(node);
            replyLayoutObservedNodes.delete(node);
        }
        for (const node of nextNodes) {
            if (replyLayoutObservedNodes.has(node)) continue;
            replyLayoutResizeObserver.observe(node);
            replyLayoutObservedNodes.add(node);
        }
    }

    function showPreviewByIdentity(identity, bar) {
        const index = turns.findIndex(turn => turn.identity === identity);
        if (index >= 0) showPreview(index, bar);
    }

    /******************************************************************
     * 根据消息数量调节 bar 间距
     *
     * 普通对话：
     *   4px bar + 8px gap
     *
     * 超长对话：
     *   自动压缩
     ******************************************************************/

    function updateRailDensity(force = false) {
        if (!rail) return;

        const count = turns.length;

        if (!count) return;

        const height = Math.max(0, window.innerHeight);
        const listMaxHeight = Math.max(0, Math.floor(height * 0.72));
        const available = Math.max(0, listMaxHeight - 16);

        let barHeight = 4;
        let gap = 8;

        const normalHeight =
            count * barHeight +
            Math.max(0, count - 1) * gap;

        if (normalHeight > available) {
            if (count < 100) {
                gap = 6;
            } else if (count < 180) {
                gap = 4;
            } else {
                gap = 3;
            }

            barHeight = Math.floor(
                (
                    available -
                    Math.max(0, count - 1) * gap
                ) / count
            );

            barHeight = Math.max(
                2,
                Math.min(4, barHeight)
            );
        }

        const pixelRatio = window.devicePixelRatio || 1;
        const snapSize = size => Math.round(size * pixelRatio) / pixelRatio;
        const snappedBarHeight = snapSize(barHeight);
        const snappedGap = snapSize(gap);
        const densityKey = [
            count,
            listMaxHeight,
            snappedBarHeight,
            snappedGap,
            pixelRatio
        ].join(':');
        const layoutKey = `${densityKey}|${turnSignature}`;
        const densityChanged = densityKey !== railDensityCacheKey;
        if (!force && !densityChanged && layoutKey === railLayoutSignature) {
            return;
        }
        railDensityCacheKey = densityKey;
        railLayoutSignature = layoutKey;

        const barHeightValue = `${snappedBarHeight}px`;
        const gapValue = `${snappedGap}px`;
        const maxHeightValue = `${listMaxHeight}px`;
        if (rail.style.getPropertyValue('--yw-nav-bar-height') !== barHeightValue) {
            rail.style.setProperty('--yw-nav-bar-height', barHeightValue);
        }
        if (rail.style.getPropertyValue('--yw-nav-gap') !== gapValue) {
            rail.style.setProperty('--yw-nav-gap', gapValue);
        }
        if (barList.style.maxHeight !== maxHeightValue) {
            barList.style.maxHeight = maxHeightValue;
        }

        /*
         * 页面缩放及容器居中会让横条落在小数物理像素上，造成粗细交替。
         * 批量读取位置后再写入偏移，避免反复布局；扣除旧偏移防止累积。
         */
        const offsets = Array.from(barList.children, bar => {
            const previousOffset = parseFloat(
                bar.style.getPropertyValue('--yw-nav-bar-offset')
            ) || 0;
            const top = bar.getBoundingClientRect().top - previousOffset;
            const offset = Math.round(top * pixelRatio) / pixelRatio - top;
            return Math.abs(offset) < 0.01 ? 0 : offset;
        });

        offsets.forEach((offset, index) => {
            const bar = barList.children[index];
            const value = `${offset}px`;
            const previous = parseFloat(
                bar.style.getPropertyValue('--yw-nav-bar-offset')
            ) || 0;
            if (Math.abs(previous - offset) >= 0.01) {
                bar.style.setProperty('--yw-nav-bar-offset', value);
            }
        });
    }


    /******************************************************************
     * Render bars
     ******************************************************************/

    function createTurnBar(turn, index, labelSource) {
        const bar = document.createElement('button');
        bar.type = 'button';
        bar.className = 'yw-turn-bar';
        bar.dataset.ywIdentity = turn.identity;
        bar.setAttribute('aria-label', getTurnBarLabel(turn, index, labelSource));
        bar.addEventListener('mouseenter', () => {
            showPreviewByIdentity(turn.identity, bar);
        });
        bar.addEventListener('mouseleave', hidePreviewSoon);
        bar.addEventListener('focus', () => {
            showPreviewByIdentity(turn.identity, bar);
        });
        bar.addEventListener('blur', hidePreviewSoon);
        bar.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            jumpToIdentity(turn.identity);
        });
        return bar;
    }

    function renderTurns() {
        cancelRebuildSchedule();
        handleRouteChange(false);
        ensureUI();

        clearTimeout(contentRefreshTimer);
        contentRefreshTimer = null;
        pendingContentRefreshes.clear();
        mountedStructureFingerprint = readMountedStructureFingerprint();

        const observedTurns = collectTurns().filter(trackCurrentRouteTurn);
        mergeObservedTurnRecords(observedTurns, true, true, true);
        const index = getConversationIndex(currentChatIdentity);
        mountedTurnsByIdentity = new Map();
        const labelSources = new Map();
        for (const turn of observedTurns) {
            const indexedEntry = index.resolveEntry(
                toIndexRecord(turn),
                {kind: turn.kind}
            );
            const identity = indexedEntry?.identity || turn.identity;
            labelSources.set(identity, turn);
            if (!turn.root?.isConnected) continue;
            mountedTurnsByIdentity.set(identity, turn);
        }
        syncThreadResizeTargets(observedTurns);
        const newTurns = buildRenderedTurns(observedTurns);

        const newSignature = newTurns
            .map(turn => turn.identity)
            .join('|');
        const previousActiveIdentity = turns[activeIndex]?.identity || null;
        const structureIsCurrent = newSignature === turnSignature &&
            newTurns.length === turns.length &&
            barList.children.length === newTurns.length &&
            newTurns.every((turn, index) =>
                barList.children[index]?.dataset.ywIdentity === turn.identity
            );

        /*
         * key 顺序没变时不重建 DOM，
         * 但仍然更新 root 引用。
         *
         * ChatGPT virtualization 有可能重新创建节点。
         */
        if (structureIsCurrent) {
            turns = newTurns;
            updateRailDensity();
            newTurns.forEach((turn, index) => {
                barList.children[index]?.setAttribute(
                    'aria-label',
                    getTurnBarLabel(
                        turn,
                        index,
                        labelSources.get(turn.identity) || turn
                    )
                );
            });
            rail.style.display = newTurns.length ? 'flex' : 'none';
            updateHistoryControl();
            if (!newTurns.length) preview.classList.remove('yw-visible');
            scheduleActiveUpdate();
            updateReplyTopButton();
            return;
        }

        const nextActiveIndex = previousActiveIdentity
            ? newTurns.findIndex(turn => turn.identity === previousActiveIdentity)
            : -1;
        if (previousActiveIdentity && nextActiveIndex < 0) setActive(-1);

        turns = newTurns;
        turnSignature = newSignature;

        if (turns.length === 0) {
            activeIndex = -1;
            if (barList.children.length) barList.replaceChildren();
            rail.style.display = 'none';
            updateHistoryControl();
            preview.classList.remove('yw-visible');
            updateReplyTopButton();
            railDensityCacheKey = '';
            railLayoutSignature = '';
            return;
        }

        const existingBars = new Map(
            Array.from(barList.children, bar => [bar.dataset.ywIdentity, bar])
        );
        turns.forEach((turn, index) => {
            const labelSource = labelSources.get(turn.identity) || turn;
            const bar = existingBars.get(turn.identity) ||
                createTurnBar(turn, index, labelSource);
            bar.dataset.ywIdentity = turn.identity;
            bar.setAttribute('aria-label', getTurnBarLabel(turn, index, labelSource));
            const current = barList.children[index] || null;
            if (current !== bar) barList.insertBefore(bar, current);
            existingBars.delete(turn.identity);
        });
        while (barList.children.length > turns.length) {
            barList.lastElementChild.remove();
        }

        activeIndex = nextActiveIndex;
        Array.from(barList.children).forEach((bar, index) => {
            const active = index === activeIndex;
            bar.classList.toggle('yw-active', active);
            if (active) bar.setAttribute('aria-current', 'true');
            else bar.removeAttribute('aria-current');
        });
        rail.style.display = 'flex';
        updateHistoryControl();
        updateRailDensity(true);
        if (activeIndex >= 0) keepActiveBarVisible(barList.children[activeIndex]);
        scheduleActiveUpdate();
        updateReplyTopButton();
    }


    /******************************************************************
     * 当前阅读位置
     ******************************************************************/

    function setActive(index) {
        if (!rail) return;
        if (index === activeIndex) return;

        if (
            activeIndex >= 0 &&
            barList.children[activeIndex]
        ) {
            barList.children[activeIndex]
                .classList.remove('yw-active');

            barList.children[activeIndex]
                .removeAttribute('aria-current');
        }

        activeIndex = index;

        if (
            activeIndex >= 0 &&
            barList.children[activeIndex]
        ) {
            const bar = barList.children[activeIndex];

            bar.classList.add('yw-active');
            bar.setAttribute('aria-current', 'true');

            keepActiveBarVisible(bar);
        }
    }

    function keepActiveBarVisible(bar) {
        if (!rail || !bar) return;

        const top = bar.offsetTop;
        const bottom = top + bar.offsetHeight;

        const visibleTop = barList.scrollTop;
        const visibleBottom =
            barList.scrollTop + barList.clientHeight;

        if (top < visibleTop) {
            barList.scrollTop =
                Math.max(0, top - barList.clientHeight * 0.25);
        } else if (bottom > visibleBottom) {
            barList.scrollTop =
                bottom - barList.clientHeight * 0.75;
        }
    }

    function getCurrentReplyContext() {
        if (currentChatIdentity === null) return null;
        if (getChatIdentity() !== currentChatIdentity) {
            handleRouteChange();
            return null;
        }

        const candidates = [];
        for (const turn of turns) {
            const mounted = mountedTurnsByIdentity.get(turn.identity) || turn;
            if (!mounted.root?.isConnected) continue;

            const reply = getAssistantReplyTarget(mounted);
            if (!reply?.isConnected) continue;
            const rect = reply.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;

            const scrollContext = createScrollContext(reply);
            const viewport = getScrollViewportGeometry(scrollContext, reply);
            const headerInset = getFixedHeaderInset(reply, scrollContext);
            const bottomInset = getFixedBottomInset(reply, scrollContext);
            const visibleTop = viewport.top + headerInset;
            const visibleBottom = viewport.bottom - bottomInset;
            if (visibleBottom <= visibleTop) continue;

            const readingY = Math.max(
                visibleTop,
                Math.min(
                    visibleBottom,
                    viewport.top + viewport.height * 0.38
                )
            );
            const messageIds = getTurnMessageIds(mounted);
            const messageId = mounted.kind === 'assistant'
                ? (mounted.messageId || messageIds.messageId)
                : (mounted.assistantMessageIds?.[0] ||
                    messageIds.assistantMessageIds[0] || '');

            candidates.push({
                turn: mounted,
                identity: turn.identity,
                messageId,
                reply,
                rect,
                scrollContext,
                viewport,
                headerInset,
                bottomInset,
                visibleTop,
                visibleBottom,
                visibleLeft: viewport.left,
                visibleRight: viewport.right,
                readingY
            });
        }

        const selected = chooseCurrentReplyCandidate(candidates);
        return selected
            ? {...selected, chatIdentity: currentChatIdentity}
            : null;
    }

    function getReplyHeadingEntries(context) {
        if (!context?.reply?.isConnected) return [];
        const selector =
            'h1.Heading-Ro3lZr, h2.Heading-Ro3lZr, ' +
            'h3.Heading-Ro3lZr, h4.Heading-Ro3lZr, ' +
            'h5.Heading-Ro3lZr, h6.Heading-Ro3lZr, ' +
            'h1[data-d-component="title"], h2[data-d-component="title"], ' +
            'h3[data-d-component="title"], h4[data-d-component="title"], ' +
            'h5[data-d-component="title"], h6[data-d-component="title"]';
        const matches = Array.from(context.reply.querySelectorAll(selector));
        if (context.reply.matches?.(selector)) matches.unshift(context.reply);

        return matches
            .filter(element =>
                element.isConnected &&
                context.reply.contains(element) &&
                !element.closest('[data-d-component="box"]')
            )
            .map(element => ({
                element,
                level: Number(element.tagName.slice(1)),
                text: element.textContent.trim(),
                top: element.getBoundingClientRect().top
            }))
            .filter(entry => entry.level >= 1 && entry.level <= 6 && entry.text);
    }

    function renderReplyOutline(context, entries) {
        const ui = replyNavigationUI;
        if (!ui) return;
        updateReplyOutlineToggleLabel();
        const sameOwner =
            ui.outlineChatIdentity === context.chatIdentity &&
            ui.outlineIdentity === context.identity &&
            ui.outlineReply === context.reply;
        const previous = ui.outlineEntries || [];
        const sameEntries = sameOwner && previous.length === entries.length &&
            entries.every((entry, index) =>
                previous[index]?.element === entry.element &&
                previous[index]?.level === entry.level &&
                previous[index]?.text === entry.text
            );
        if (sameEntries) return;

        ui.list.replaceChildren();
        ui.outlineChatIdentity = context.chatIdentity;
        ui.outlineIdentity = context.identity;
        ui.outlineReply = context.reply;
        ui.outlineEntries = entries;

        if (!entries.length) {
            const empty = document.createElement('li');
            empty.className = 'yw-reply-outline-empty';
            empty.textContent = '当前回复没有可跳转的标题';
            ui.list.appendChild(empty);
            return;
        }

        for (const entry of entries) {
            const item = document.createElement('li');
            item.className = 'yw-reply-outline-item';
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'yw-reply-outline-target';
            button.style.paddingInlineStart = `${6 + (entry.level - 1) * 8}px`;
            button.textContent = entry.text;
            button.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();
                scrollToReplyHeading(context, entry);
            });
            item.appendChild(button);
            ui.list.appendChild(item);
        }
    }

    function getReplyThreadContentLayout(context = replyNavigationContext) {
        const rectIsVisible = element => {
            const rect = element?.getBoundingClientRect?.();
            return rect?.width > 0 && rect?.height > 0;
        };
        const candidates = Array.from(
            document.querySelectorAll?.(
                '[class*="thread-scroll-layout"]'
            ) || []
        ).filter(element =>
            String(element.className || '')
                .split(/\s+/)
                .includes('group/thread-scroll-layout') &&
            rectIsVisible(element)
        );
        const active = context?.reply?.isConnected
            ? candidates.find(element => element.contains?.(context.reply))
            : null;
        return active || candidates[0] || null;
    }

    function readReplyThreadContentX(element) {
        return element?.style?.getPropertyValue?.('--thread-content-x') || '';
    }

    function hasNonzeroThreadContentX(value) {
        const normalized = String(value || '').trim();
        if (!normalized || normalized === 'initial') return false;
        const pixelMatch = normalized.match(
            /^([-+]?(?:\d+\.?\d*|\.\d+))px$/
        );
        return !pixelMatch || Math.abs(Number(pixelMatch[1])) > 0.01;
    }

    function cancelReplyOutlineContentShiftAnimation() {
        if (
            replyOutlineContentShiftFrame !== null &&
            typeof cancelAnimationFrame === 'function'
        ) {
            cancelAnimationFrame(replyOutlineContentShiftFrame);
        }
        replyOutlineContentShiftFrame = null;
    }

    function writeReplyOutlineContentShift(state, pixels) {
        if (!state?.element?.isConnected) return;
        const normalized = Number(pixels) > 0
            ? Math.round(Number(pixels))
            : 0;
        const desired = composeThreadContentX(
            state.baseValue,
            normalized
        );
        const current = readReplyThreadContentX(state.element);
        if (current !== desired) {
            if (desired) {
                state.element.style.setProperty(
                    '--thread-content-x',
                    desired
                );
            } else {
                state.element.style.removeProperty('--thread-content-x');
            }
        }
        state.appliedPixels = normalized;
        state.appliedValue = desired;
    }

    function animateReplyOutlineContentShift(state, targetPixels) {
        cancelReplyOutlineContentShiftAnimation();
        const target = Math.max(0, Math.round(Number(targetPixels) || 0));
        state.targetPixels = target;
        const startPixels = state.appliedPixels;
        if (startPixels === target) {
            writeReplyOutlineContentShift(state, target);
            if (target === 0) replyOutlineContentShiftState = null;
            return;
        }
        const reduceMotion = Boolean(
            window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
        );
        if (
            reduceMotion ||
            typeof requestAnimationFrame !== 'function' ||
            typeof performance === 'undefined' ||
            typeof performance.now !== 'function'
        ) {
            writeReplyOutlineContentShift(state, target);
            if (target === 0) replyOutlineContentShiftState = null;
            return;
        }

        const startedAt = performance.now();
        const duration = REPLY_OUTLINE_CONTENT_SHIFT_DURATION_MS;
        const step = now => {
            replyOutlineContentShiftFrame = null;
            if (
                state !== replyOutlineContentShiftState ||
                !state.element?.isConnected
            ) {
                return;
            }
            const progress = Math.max(
                0,
                Math.min(1, (now - startedAt) / duration)
            );
            const eased = 1 - Math.pow(1 - progress, 3);
            const pixels = startPixels + (target - startPixels) * eased;
            if (progress < 1) {
                writeReplyOutlineContentShift(state, pixels);
                replyOutlineContentShiftFrame = requestAnimationFrame(step);
                return;
            }
            writeReplyOutlineContentShift(state, target);
            if (target === 0) replyOutlineContentShiftState = null;
        };
        replyOutlineContentShiftFrame = requestAnimationFrame(step);
    }

    function restoreReplyOutlineContentShift({animate = false} = {}) {
        const state = replyOutlineContentShiftState;
        if (!state?.element?.isConnected) {
            cancelReplyOutlineContentShiftAnimation();
            replyOutlineContentShiftState = null;
            return;
        }
        const current = readReplyThreadContentX(state.element);
        if (current !== state.appliedValue) {
            // ChatGPT changed the native layout value; preserve that newer state.
            cancelReplyOutlineContentShiftAnimation();
            replyOutlineContentShiftState = null;
            return;
        }
        if (animate && state.appliedPixels > 0) {
            if (
                replyOutlineContentShiftFrame !== null &&
                state.targetPixels === 0
            ) {
                return;
            }
            animateReplyOutlineContentShift(state, 0);
            return;
        }
        cancelReplyOutlineContentShiftAnimation();
        if (state.baseValue) {
            state.element.style.setProperty(
                '--thread-content-x',
                state.baseValue
            );
        } else {
            state.element.style.removeProperty('--thread-content-x');
        }
        replyOutlineContentShiftState = null;
    }

    function applyReplyOutlineContentShift(
        element,
        shift,
        chatIdentity = currentChatIdentity,
        animate = false
    ) {
        if (!element?.style) {
            restoreReplyOutlineContentShift({animate});
            return;
        }
        let state = replyOutlineContentShiftState;
        const previousPixels = state?.chatIdentity === chatIdentity
            ? state.appliedPixels
            : 0;
        if (
            state?.element !== element ||
            state.chatIdentity !== chatIdentity
        ) {
            restoreReplyOutlineContentShift();
            state = {
                element,
                chatIdentity,
                baseValue: readReplyThreadContentX(element),
                appliedPixels: previousPixels,
                appliedValue: readReplyThreadContentX(element),
                targetPixels: 0
            };
            replyOutlineContentShiftState = state;
        } else {
            const current = readReplyThreadContentX(element);
            if (current !== state.appliedValue) {
                state.baseValue = current;
                state.appliedPixels = 0;
                state.appliedValue = current;
            }
        }

        const pixels = Number(shift) > 0 ? Math.floor(Number(shift)) : 0;
        if (
            animate &&
            replyOutlineContentShiftFrame !== null &&
            state.targetPixels === pixels
        ) {
            return;
        }
        if (animate) {
            animateReplyOutlineContentShift(state, pixels);
            return;
        }
        cancelReplyOutlineContentShiftAnimation();
        writeReplyOutlineContentShift(state, pixels);
    }

    function positionReplyOutline() {
        const ui = replyNavigationUI;
        if (!ui || !replyOutlineOpen || ui.root.hidden) {
            restoreReplyOutlineContentShift();
            return;
        }
        const toolbarRect = ui.toolbar.getBoundingClientRect();
        if (
            ui.toolbar.hidden || toolbarRect.width <= 0 ||
            toolbarRect.height <= 0
        ) {
            restoreReplyOutlineContentShift();
            return;
        }
        const position = computeReplyOutlinePosition({
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            toolbarLeft: toolbarRect.left,
            toolbarWidth: toolbarRect.width,
            viewportInset: REPLY_NAV_VIEWPORT_INSET,
            toolbarGap: REPLY_NAV_TOOLBAR_GAP
        });
        if (!position) {
            restoreReplyOutlineContentShift();
            return;
        }
        ui.outline.style.left = `${position.left}px`;
        ui.outline.style.width = `${position.width}px`;
        ui.outline.style.maxHeight = `${position.maxHeight}px`;
        ui.outline.hidden = !position.visible;
        if (position.visible) {
            const outlineRect = ui.outline.getBoundingClientRect();
            const toggleRect = ui.outlineToggle.getBoundingClientRect();
            const top = computeReplyOutlineTop({
                windowHeight: window.innerHeight,
                panelHeight: outlineRect.height,
                toggleTop: toggleRect.height > 0 ? toggleRect.top : null,
                viewportInset: REPLY_NAV_VIEWPORT_INSET
            });
            if (Number.isFinite(top)) {
                ui.outline.style.top = `${top}px`;
            }
        }

        const context = replyNavigationContext;
        const contentLayout = getReplyThreadContentLayout(context);
        let shift = 0;
        if (
            position.visible && contentLayout &&
            context?.reply?.isConnected && context.rect &&
            Number.isFinite(Number(context.rect.left)) &&
            Number.isFinite(Number(context.rect.right))
        ) {
            const state = replyOutlineContentShiftState?.element === contentLayout &&
                replyOutlineContentShiftState.chatIdentity === currentChatIdentity
                ? replyOutlineContentShiftState
                : null;
            const baseValue = state
                ? state.baseValue
                : readReplyThreadContentX(contentLayout);
            if (!hasNonzeroThreadContentX(baseValue)) {
                const appliedPixels = state?.appliedPixels || 0;
                const railRect = document.getElementById(RAIL_ID)
                    ?.getBoundingClientRect();
                const rightBoundary = railRect?.width > 0
                    ? railRect.left
                    : window.innerWidth - REPLY_NAV_VIEWPORT_INSET;
                shift = computeReplyContentShift({
                    contentRight: Number(context.rect.right) - appliedPixels,
                    rightBoundary,
                    contentGap: REPLY_OUTLINE_CONTENT_GAP,
                    preferredShift: REPLY_OUTLINE_CONTENT_SHIFT
                });
            }
        }
        applyReplyOutlineContentShift(
            contentLayout,
            shift,
            currentChatIdentity,
            true
        );

        const expanded = String(Boolean(
            position.visible && replyOutlineOpen && !ui.outline.hidden
        ));
        if (ui.outlineToggle.getAttribute('aria-expanded') !== expanded) {
            ui.outlineToggle.setAttribute('aria-expanded', expanded);
        }
    }

    function showReplyOutlineTooltip() {
        const ui = replyNavigationUI;
        const toggle = ui?.outlineToggle;
        const tooltip = ui?.outlineTooltip;
        if (
            replyOutlineOpen || !toggle?.isConnected || toggle.hidden ||
            !tooltip || ui.root.hidden
        ) {
            hideReplyOutlineTooltip();
            return;
        }
        const anchor = toggle.getBoundingClientRect();
        if (!anchor.width || !anchor.height) {
            hideReplyOutlineTooltip();
            return;
        }
        tooltip.hidden = false;
        tooltip.dataset.visible = 'false';
        const rect = tooltip.getBoundingClientRect();
        const position = computeReplyOutlineTooltipPosition({
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            anchorLeft: anchor.left,
            anchorRight: anchor.right,
            anchorTop: anchor.top,
            anchorHeight: anchor.height,
            tooltipWidth: rect.width,
            tooltipHeight: rect.height
        });
        if (!position) {
            hideReplyOutlineTooltip();
            return;
        }
        tooltip.style.left = `${position.left}px`;
        tooltip.style.top = `${position.top}px`;
        tooltip.dataset.visible = 'true';
    }

    function hideReplyOutlineTooltip() {
        const tooltip = replyNavigationUI?.outlineTooltip;
        if (!tooltip) return;
        tooltip.dataset.visible = 'false';
        tooltip.hidden = true;
        tooltip.style.removeProperty('left');
        tooltip.style.removeProperty('top');
    }

    function setReplyOutlineOpen(open) {
        const ui = replyNavigationUI;
        if (!ui) return;
        const canOpen = Boolean(
            open && replyNavigationContext?.reply?.isConnected &&
            !ui.root.hidden
        );
        replyOutlineOpenPreference = canOpen;
        persistReplyOutlineOpenPreference();
        replyOutlineOpen = canOpen;
        updateReplyOutlineToggleLabel();
        ui.outline.hidden = !replyOutlineOpen;
        if (!replyNavigationContext && !replyOutlineOpen) {
            ui.root.hidden = true;
        }
        if (replyOutlineOpen) positionReplyOutline();
        else restoreReplyOutlineContentShift({animate: true});
        ui.outlineToggle.setAttribute(
            'aria-expanded',
            String(Boolean(replyOutlineOpen && !ui.root.hidden && !ui.outline.hidden))
        );
        syncReplyOutlineToggleBinding();
        syncReplyOutlineToggleTooltip();
    }

    function toggleReplyOutline() {
        updateReplyTopButton();
        if (!replyNavigationUI || replyNavigationUI.root.hidden) return;
        setReplyOutlineOpen(!replyOutlineOpen);
    }

    function updateReplyOutlineToggleLabel() {
        const ui = replyNavigationUI;
        if (!ui?.outlineToggle) return;
        const label = replyOutlineOpen ? '收起大纲' : '展开大纲';
        if (ui.outlineToggle.getAttribute('aria-label') !== label) {
            ui.outlineToggle.setAttribute('aria-label', label);
        }
    }

    function canHoldReplyNavigationLayout() {
        const ui = replyNavigationUI;
        return Boolean(
            ui && replyOutlineOpen &&
            !ui.root.hidden && !ui.toolbar.hidden && !ui.outline.hidden &&
            ui.toolbar.style.left && ui.toolbar.style.top &&
            ui.outline.style.left && ui.outline.style.top
        );
    }

    function clearReplyNavigation({preserveOutlineOpen = false} = {}) {
        if (replyNavigationRAF !== null) {
            cancelAnimationFrame(replyNavigationRAF);
            replyNavigationRAF = null;
        }
        if (!preserveOutlineOpen) assistantReplyNavigationCursor = null;
        hideReplyOutlineTooltip();
        replyNavigationContext = null;
        if (!preserveOutlineOpen) replyOutlineOpen = false;
        updateReplyOutlineToggleLabel();
        const holdLayout = preserveOutlineOpen &&
            canHoldReplyNavigationLayout();
        if (holdLayout) {
            replyNavigationUI.outlineToggle.hidden = false;
            replyNavigationUI.outlineToggle.setAttribute(
                'aria-expanded',
                'true'
            );
            if (replyTopButton) {
                replyTopButton.hidden = true;
                delete replyTopButton.dataset.identity;
                delete replyTopButton.dataset.messageId;
            }
            syncReplyOutlineToggleBinding();
            return;
        }
        restoreReplyOutlineContentShift();
        disconnectReplyNavigationLayoutObservers();
        if (replyNavigationUI) {
            replyNavigationUI.root.hidden = true;
            replyNavigationUI.outline.hidden = true;
            replyNavigationUI.toolbar.hidden = true;
            replyNavigationUI.outlineToggle.hidden = true;
            replyNavigationUI.outlineToggle.setAttribute(
                'aria-expanded',
                'false'
            );
            replyNavigationUI.toolbar.style.removeProperty('left');
            replyNavigationUI.toolbar.style.removeProperty('top');
            replyNavigationUI.outlineToggle.style.removeProperty('left');
            replyNavigationUI.outlineToggle.style.removeProperty('top');
            replyNavigationUI.outline.style.removeProperty('left');
            replyNavigationUI.outline.style.removeProperty('top');
            replyNavigationUI.outline.style.removeProperty('width');
            replyNavigationUI.outline.style.removeProperty('max-height');
            replyNavigationUI.list.replaceChildren();
            replyNavigationUI.outlineEntries = [];
            replyNavigationUI.outlineChatIdentity = null;
            replyNavigationUI.outlineIdentity = null;
            replyNavigationUI.outlineReply = null;
        }
        if (replyTopButton) {
            replyTopButton.hidden = true;
            delete replyTopButton.dataset.identity;
            delete replyTopButton.dataset.messageId;
        }
        syncReplyOutlineToggleBinding();
    }

    function resetReplyNavigationForConversationChange() {
        clearReplyNavigation();
        replyOutlineOpen = replyOutlinePinned && replyOutlineOpenPreference;
        updateReplyOutlineToggleLabel();
    }

    function getAssistantReplyNavigationEntries() {
        return turns.filter(entry => {
            if (entry.kind === 'assistant') return true;
            if (entry.kind !== 'user') return false;
            if (String(entry.assistantText || '').trim()) return true;
            if (entry.assistantMessageIds?.length) return true;
            return Boolean(getAssistantReplyTarget(findMountedTurn(entry.identity)));
        });
    }

    function getAssistantReplyNavigationBoundary(context) {
        const entries = getAssistantReplyNavigationEntries();
        const pending = assistantReplyNavigationCursor;
        const pendingIsCurrent = Boolean(
            pending?.chatIdentity === currentChatIdentity &&
            pending.userScrollGeneration === userScrollGeneration &&
            pending.search === activeJumpSearch &&
            pending.search?.assistantReplyNavigation === true &&
            pending.search.settled !== true &&
            pending.search.cancelled !== true &&
            entries.some(entry => entry.identity === pending.identity)
        );
        const identity = pendingIsCurrent
            ? pending.identity
            : context?.identity || '';
        const index = entries.findIndex(entry => entry.identity === identity);
        return {
            entries,
            index,
            previous: index > 0,
            next: index >= 0 && index < entries.length - 1
        };
    }

    function updateAssistantReplyNavigationButtons(context) {
        const ui = replyNavigationUI;
        if (!ui) return;
        const boundary = getAssistantReplyNavigationBoundary(context);
        ui.buttons.get('previous-reply').disabled = !boundary.previous;
        ui.buttons.get('next-reply').disabled = !boundary.next;
        ui.replyButtons.get('previous').disabled = !boundary.previous;
        ui.replyButtons.get('next').disabled = !boundary.next;
    }

    function positionReplyOutlineToggle(toolbarPosition) {
        const ui = replyNavigationUI;
        if (!ui?.outlineToggle) return;
        const position = toolbarPosition
            ? computeReplyOutlineTogglePosition({
                windowWidth: window.innerWidth,
                windowHeight: window.innerHeight,
                toolbarLeft: toolbarPosition.left,
                toolbarTop: toolbarPosition.top,
                toolbarWidth: REPLY_NAV_CONTROL_SIZE,
                toggleWidth: REPLY_NAV_CONTROL_SIZE,
                toggleHeight: REPLY_NAV_CONTROL_SIZE,
                buttonGap: REPLY_OUTLINE_BUTTON_GAP,
                viewportInset: REPLY_NAV_VIEWPORT_INSET
            })
            : null;
        if (!position?.visible) {
            ui.outlineToggle.hidden = true;
            hideReplyOutlineTooltip();
            return;
        }
        ui.outlineToggle.style.left = `${position.left}px`;
        ui.outlineToggle.style.top = `${position.top}px`;
    }

    function updateReplyNavigationControls(context, headings) {
        const ui = replyNavigationUI;
        if (!ui) return;
        renderReplyOutline(context, headings);
        const up = chooseAdjacentReplyHeading(headings, context.visibleTop, 'up', 2);
        const down = chooseAdjacentReplyHeading(headings, context.visibleTop, 'down', 2);
        ui.buttons.get('first').disabled = !context.identity || !context.reply?.isConnected;
        ui.buttons.get('up').disabled = !up;
        ui.buttons.get('down').disabled = !down;
        ui.buttons.get('last').disabled = !context.reply?.isConnected;

        syncReplyNavigationLayoutObservers(context);
        ui.root.hidden = false;
        updateAssistantReplyNavigationButtons(context);

        const sidebar = getReplySidebarGeometry();
        const position = computeReplyToolbarPosition({
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            viewportLeft: 0,
            viewportRight: window.innerWidth,
            contentLeft: context.rect.left,
            sidebarLeft: sidebar?.left,
            sidebarRight: sidebar?.right,
            sidebarVisible: Boolean(sidebar),
            toolbarHeight: REPLY_NAV_TOOLBAR_HEIGHT,
            sidebarGap: REPLY_NAV_TOOLBAR_GAP,
            viewportInset: REPLY_NAV_VIEWPORT_INSET
        });
        ui.toolbar.hidden = !position;
        if (position) {
            ui.toolbar.style.left = `${position.left}px`;
            ui.toolbar.style.top = `${position.top}px`;
        }
        positionReplyOutlineToggle(position);
        syncReplyOutlineToggleBinding();

        ui.outline.hidden = !replyOutlineOpen;
        if (replyOutlineOpen) positionReplyOutline();
        else restoreReplyOutlineContentShift({animate: true});
    }

    function isCurrentReplyNavigationContext(context) {
        if (
            !context ||
            context.chatIdentity !== currentChatIdentity ||
            context.chatIdentity !== getChatIdentity() ||
            !context.reply?.isConnected
        ) {
            return false;
        }
        const mounted = findMountedTurn(context.identity);
        const selected = getCurrentReplyContext();
        return Boolean(
            selected?.identity === context.identity &&
            selected.reply === context.reply &&
            mounted?.root?.isConnected &&
            getAssistantReplyTarget(mounted) === context.reply
        );
    }

    function alignReplyElement(target, edge) {
        if (!target?.isConnected) return;
        cancelJumpSearch();
        const scrollContext = createScrollContext(target);
        const viewport = getScrollViewportGeometry(scrollContext, target);
        const rect = target.getBoundingClientRect();
        const topInset = getFixedHeaderInset(target, scrollContext);
        const bottomInset = getFixedBottomInset(target, scrollContext);
        const delta = computeReplyScrollDelta({
            targetTop: rect.top,
            targetBottom: rect.bottom,
            viewportTop: viewport.top,
            viewportBottom: viewport.bottom,
            topInset,
            bottomInset,
            edge
        });
        const desiredTop = scrollContext.getTop() + delta;
        extendScrollRangeTo(scrollContext, desiredTop);
        scrollContext.setTop(desiredTop);
    }

    function scrollToReplyHeading(context, entry) {
        if (
            !isCurrentReplyNavigationContext(context) ||
            !entry?.element?.isConnected ||
            !context.reply.contains(entry.element)
        ) {
            return;
        }
        alignReplyElement(entry.element, 'top');
    }

    function jumpToCurrentReplyTop() {
        const context = getCurrentReplyContext();
        if (!context?.identity) return;
        replyNavigationContext = context;
        jumpToIdentity(
            context.identity,
            context.messageId || '',
            {replyTop: true}
        );
    }

    function navigateReplyHeading(direction) {
        const context = getCurrentReplyContext();
        if (!context) return;
        replyNavigationContext = context;
        const entries = getReplyHeadingEntries(context);
        const heading = chooseAdjacentReplyHeading(
            entries,
            context.visibleTop,
            direction,
            2
        );
        if (heading) scrollToReplyHeading(context, heading);
    }

    function navigateAssistantReply(direction) {
        const context = getCurrentReplyContext();
        const boundary = getAssistantReplyNavigationBoundary(context);
        const index = boundary.index;
        if (index < 0) return;
        const nextIndex = index + (direction === 'previous' ? -1 : 1);
        const target = boundary.entries[nextIndex];
        if (!target) return;

        jumpToIdentity(target.identity, '', {replyTop: true});
        const search = activeJumpSearch;
        if (
            !search || search.identity !== target.identity ||
            search.userScrollGeneration !== userScrollGeneration ||
            search.options?.replyTop !== true
        ) {
            assistantReplyNavigationCursor = null;
            return;
        }
        search.assistantReplyNavigation = true;
        assistantReplyNavigationCursor = {
            chatIdentity: currentChatIdentity,
            userScrollGeneration,
            identity: target.identity,
            search
        };
        if (context) replyNavigationContext = context;
    }

    function jumpToCurrentReplyBottom() {
        const context = getCurrentReplyContext();
        if (!isCurrentReplyNavigationContext(context)) return;
        replyNavigationContext = context;
        alignReplyElement(context.reply, 'bottom');
    }

    function updateReplyTopButton() {
        if (!replyTopButton) return;
        const context = getCurrentReplyContext();
        if (!context) {
            clearReplyNavigation({preserveOutlineOpen: true});
            return;
        }

        replyNavigationContext = context;
        const headings = getReplyHeadingEntries(context);
        updateReplyNavigationControls(context, headings);
        if (replyNavigationUI?.outlineTooltip?.dataset.visible === 'true') {
            showReplyOutlineTooltip();
        }

        if (
            context.rect.top >= context.visibleTop ||
            context.rect.top > context.readingY ||
            context.rect.bottom < context.readingY
        ) {
            replyTopButton.hidden = true;
            delete replyTopButton.dataset.identity;
            delete replyTopButton.dataset.messageId;
            return;
        }

        replyTopButton.dataset.identity = context.identity;
        if (context.messageId) {
            replyTopButton.dataset.messageId = context.messageId;
        } else {
            delete replyTopButton.dataset.messageId;
        }
        replyTopButton.style.left = `${context.rect.left + context.rect.width / 2}px`;
        replyTopButton.style.top = `${context.viewport.top + 24}px`;
        replyTopButton.hidden = false;
    }

    function updateActiveTurn() {
        activeRAF = null;

        if (!turns.length) {
            setActive(-1);
            return;
        }

        /*
         * 用 viewport 上方约 38% 的位置作为“当前阅读点”。
         * 比严格用屏幕中央更符合阅读长回复时的感受。
         */
        const targetY = window.innerHeight * 0.38;

        let bestIndex = -1;
        let bestDistance = Infinity;

        for (let i = 0; i < turns.length; i++) {
            const root = mountedTurnsByIdentity.get(turns[i].identity)?.root ||
                turns[i].root;

            if (!root?.isConnected) continue;

            const rect = root.getBoundingClientRect();

            if (!rect.width && !rect.height) continue;

            let distance;

            if (
                targetY >= rect.top &&
                targetY <= rect.bottom
            ) {
                distance = 0;
            } else {
                distance = Math.min(
                    Math.abs(targetY - rect.top),
                    Math.abs(targetY - rect.bottom)
                );
            }

            if (distance < bestDistance) {
                bestDistance = distance;
                bestIndex = i;
            }
        }

        setActive(bestIndex);
        updateReplyTopButton();
    }

    function scheduleActiveUpdate() {
        if (activeRAF !== null) return;

        activeRAF =
            requestAnimationFrame(updateActiveTurn);
    }


    /******************************************************************
     * DOM 改变时重新扫描
     ******************************************************************/

    function cancelRebuildSchedule() {
        if (rebuildTimer !== null) {
            clearTimeout(rebuildTimer);
            rebuildTimer = null;
        }
        if (rebuildMaxWaitTimer !== null) {
            clearTimeout(rebuildMaxWaitTimer);
            rebuildMaxWaitTimer = null;
        }
        rebuildDirty = false;
        rebuildImmediatePending = false;
    }

    function flushScheduledRebuild() {
        const shouldRender = rebuildDirty;
        cancelRebuildSchedule();
        if (!shouldRender) return;
        renderTurns();
        retryNativeAdapterBinding();
    }

    function scheduleRebuild(delay = 180) {
        rebuildDirty = true;
        if (rebuildMaxWaitTimer === null) {
            rebuildMaxWaitTimer = setTimeout(flushScheduledRebuild, 2500);
        }

        if (delay <= 0) {
            if (rebuildImmediatePending) return;
            rebuildImmediatePending = true;
        } else if (rebuildImmediatePending) {
            return;
        }

        if (rebuildTimer !== null) clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(
            flushScheduledRebuild,
            rebuildImmediatePending ? 0 : delay
        );
    }

    const STRUCTURE_ATTRIBUTES = [
        'data-turn-key',
        'data-content-search-turn-key',
        'data-user-message-bubble',
        'data-content-search-unit-key',
        'data-chatgpt-search-unit-key',
        'data-conversation-role',
        'data-chatgpt-search-message-ids',
        'data-chatgpt-selection-message-id',
        'data-message-id'
    ];
    const STRUCTURE_NODE_SELECTOR = TURN_NODE_SELECTOR +
        ', [data-chatgpt-search-message-ids], ' +
        '[data-chatgpt-selection-message-id], [data-message-id]';

    function readMountedStructureFingerprint() {
        return {
            chatIdentity: currentChatIdentity,
            nodes: Array.from(document.querySelectorAll(STRUCTURE_NODE_SELECTOR), node => ({
                node,
                attributes: STRUCTURE_ATTRIBUTES.map(name => node.getAttribute(name))
            }))
        };
    }

    function mountedStructureChanged(previous, next) {
        if (previous.nodes.length !== next.nodes.length) return true;
        return next.nodes.some((item, index) => {
            const old = previous.nodes[index];
            return item.node !== old.node || item.attributes.some((value, offset) =>
                value !== old.attributes[offset]
            );
        });
    }

    function pollForUnobservedChanges() {
        handleRouteChange();
        const fingerprint = readMountedStructureFingerprint();
        if (
            !mountedStructureFingerprint ||
            mountedStructureFingerprint.chatIdentity !== currentChatIdentity
        ) {
            mountedStructureFingerprint = fingerprint;
        } else if (mountedStructureChanged(mountedStructureFingerprint, fingerprint)) {
            rebuildDirty = true;
        }
        if (rebuildDirty && rebuildTimer === null && !rebuildImmediatePending) {
            scheduleRebuild();
        }
        retryNativeLocatorBinding();
        retryNativeAdapterBinding();
    }

    function startFallbackPolling() {
        setInterval(pollForUnobservedChanges, 2500);
    }

    function nodeIsWithinMountedThread(node) {
        const element = asElement(node);
        if (!element) return false;
        for (const turn of mountedTurnsByIdentity.values()) {
            if (getTurnNodes(turn).some(root =>
                root instanceof Element &&
                root.isConnected &&
                (root === element || root.contains(element))
            )) {
                return true;
            }
        }
        return false;
    }

    function syncThreadResizeTargets(observedTurns) {
        if (typeof ResizeObserver !== 'function') return;
        if (!threadResizeObserver) {
            threadResizeObserver = new ResizeObserver(() => {
                invalidateThreadLayout();
            });
        }

        const nextNodes = new Set();
        for (const turn of observedTurns) {
            for (const node of getTurnNodes(turn)) {
                if (node instanceof Element && node.isConnected) {
                    nextNodes.add(node);
                }
            }
        }

        for (const node of threadResizeObservedNodes) {
            if (!nextNodes.has(node)) {
                threadResizeObserver.unobserve(node);
                threadResizeObservedNodes.delete(node);
            }
        }
        for (const node of nextNodes) {
            if (threadResizeObservedNodes.has(node)) continue;
            threadResizeObserver.observe(node);
            threadResizeObservedNodes.add(node);
        }
    }

    function nodeContainsTurn(node) {
        if (!(node instanceof Element)) return false;

        if (node.matches(STRUCTURE_NODE_SELECTOR)) return true;

        return Boolean(node.querySelector(STRUCTURE_NODE_SELECTOR));
    }

    function isKnownCurrentChatTurn(turn) {
        if (!turn) return false;

        if (turn.stableIdentity) {
            const knownInCurrentChat =
                turnRecordsByChat.get(currentChatIdentity)
                    ?.byIdentity.has(turn.identity) ||
                chatOwnersByTurnIdentity.get(turn.identity)
                    ?.has(currentChatIdentity);
            return Boolean(
                knownInCurrentChat && trackCurrentRouteTurn(turn)
            );
        }

        const knownFallbackNode = [turn.root, turn.userBubble].some(node =>
            node instanceof Element &&
            fallbackTurnOwnersByNode.get(node) === currentChatIdentity
        );
        return Boolean(knownFallbackNode && trackCurrentRouteTurn(turn));
    }

    function visibilityMutationAffectsCurrentChat(target) {
        const targetContainsTurn = turn =>
            [turn.root, turn.userBubble, turn.assistantUnit].some(node =>
                node instanceof Element &&
                node.isConnected &&
                (target === node || target.contains(node))
            );

        if (turns.some(turn =>
            targetContainsTurn(turn) && isKnownCurrentChatTurn(turn)
        )) {
            return true;
        }

        return collectTurns(target).some(isKnownCurrentChatTurn);
    }

    function scheduleContentRefresh(identity, observed, delay) {
        pendingContentRefreshes.set(identity, {
            identity,
            observed,
            chatIdentity: currentChatIdentity
        });
        if (contentRefreshTimer === null) {
            contentRefreshTimer = setTimeout(flushTurnContentRefreshes, delay);
        }
    }

    function scheduleNativeSnapshotProjection(changes) {
        if (changes.structureChanged) {
            scheduleRebuild(0);
            return;
        }
        if (rebuildDirty) return;
        for (const identity of changes.changedIdentities) {
            scheduleContentRefresh(
                identity,
                mountedTurnsByIdentity.get(identity) || null,
                0
            );
        }
    }

    function flushTurnContentRefreshes() {
        contentRefreshTimer = null;
        const pending = Array.from(pendingContentRefreshes.values());
        pendingContentRefreshes.clear();
        if (getChatIdentity() !== currentChatIdentity) {
            handleRouteChange();
            return;
        }
        if (rebuildDirty) return;
        let refreshed = false;
        let layoutChanged = false;
        for (const {identity, observed, chatIdentity} of pending) {
            if (chatIdentity !== currentChatIdentity) continue;
            const index = turns.findIndex(turn => turn.identity === identity);
            const turn = turns[index];
            const bar = barList?.children[index];
            if (
                !turn || bar?.dataset.ywIdentity !== identity ||
                userEditCandidates.has(identity) ||
                (observed && (
                    mountedTurnsByIdentity.get(identity) !== observed ||
                    !observed.root?.isConnected ||
                    userEditCandidates.has(observed.identity)
                )) ||
                (!observed && mountedTurnsByIdentity.has(identity))
            ) {
                scheduleRebuild();
                continue;
            }

            const record = observed
                ? updateObservedTurnContent(observed)
                : turnRecordsByChat.get(chatIdentity)?.byIdentity.get(identity);
            if (!record || record !== turn || record.identity !== identity) {
                scheduleRebuild();
                continue;
            }
            bar.setAttribute('aria-label', getTurnBarLabel(turn, index, {
                kind: record.kind,
                userText: record.userText,
                assistantText: record.assistantText
            }));
            refreshed = true;
            if (observed) layoutChanged = true;
        }

        if (refreshed) {
            if (layoutChanged) {
                invalidateThreadLayout();
                scheduleActiveUpdate();
            } else {
                scheduleReplyNavigationUpdate();
            }
        }
    }

    function queueTurnContentRefresh(node) {
        const element = asElement(node);
        if (!element) return false;
        const store = turnRecordsByChat.get(currentChatIdentity);
        if (!store) return false;

        const assistantUnit = element.matches(ASSISTANT_UNIT_SELECTOR)
            ? element
            : element.closest(ASSISTANT_UNIT_SELECTOR);
        let identity = '';
        let observed = null;
        for (const owner of [
            assistantUnit,
            element.closest('[data-user-message-bubble="true"]')
        ]) {
            identity = resolveRememberedIdentity(
                store,
                store.identitiesByNode.get(owner)
            );
            observed = identity && mountedTurnsByIdentity.get(identity);
            if (observed) break;
        }
        if (!observed) {
            for (const [mountedIdentity, mounted] of mountedTurnsByIdentity) {
                const userContent = mounted.userBubble &&
                    (mounted.userBubble === element ||
                        mounted.userBubble.contains(element));
                const assistantContent = assistantUnit && (
                    mounted.assistantUnit === assistantUnit ||
                    mounted.pairedAssistantUnits?.includes(assistantUnit)
                );
                if (!userContent && !assistantContent) continue;
                identity = mountedIdentity;
                observed = mounted;
                break;
            }
        }
        if (
            !observed?.stableIdentity || !observed.root?.isConnected ||
            userEditCandidates.has(identity) ||
            userEditCandidates.has(observed.identity)
        ) {
            return false;
        }

        /* 每 250ms 合并正文更新，流式输出只读取受影响的回合。 */
        scheduleContentRefresh(identity, observed, 250);
        return true;
    }

    function observeChatChanges() {
        document.addEventListener('input', event => {
            captureUserEditCandidatesFromMutation({
                target: event.target,
                addedNodes: [],
                removedNodes: []
            });
        }, true);

        document.addEventListener('load', event => {
            if (
                event.target instanceof Element &&
                event.target.matches('img') &&
                nodeIsWithinMountedThread(event.target)
            ) {
                invalidateThreadLayout();
            }
        }, true);

        const observer = new MutationObserver(mutations => {
            const previousChatIdentity = currentChatIdentity;
            handleRouteChange();
            const routeChanged = previousChatIdentity !== currentChatIdentity;
            if (mutations.some(isReplySidebarMutation)) {
                scheduleReplyNavigationUpdate();
            }

            let relevant = false;
            const removedTurnSnapshots = [];

            for (const mutation of mutations) {
                /*
                 * 忽略我们自己的导航 UI 修改。
                 */
                if (isOwnNavigationMutation(mutation)) continue;

                captureUserEditCandidatesFromMutation(mutation);

                if (mutation.type === 'characterData') {
                    if (
                        !queueTurnContentRefresh(mutation.target) &&
                        (findKnownUserContentTurn(mutation.target) ||
                            nodeIsWithinMountedThread(mutation.target))
                    ) {
                        relevant = true;
                    }
                    continue;
                }

                if (
                    mutation.type === 'attributes' &&
                    [
                        'style', 'class', 'hidden', 'aria-expanded', 'data-state'
                    ].includes(
                        mutation.attributeName
                    )
                ) {
                    if (visibilityMutationAffectsCurrentChat(mutation.target)) {
                        relevant = true;
                    }
                    if ([
                        'class', 'style', 'hidden', 'aria-expanded', 'data-state'
                    ].includes(mutation.attributeName)) {
                        scheduleReplyNavigationUpdate();
                    }
                    continue;
                }

                let structural = false;
                for (const node of mutation.removedNodes) {
                    if (nodeContainsTurn(node)) {
                        removedTurnSnapshots.push(...collectTurns(node));
                        structural = true;
                    }
                }

                if (
                    mutation.type === 'attributes' &&
                    (nodeContainsTurn(mutation.target) ||
                        nodeIsWithinMountedThread(mutation.target))
                ) {
                    structural = true;
                    collectTurns(mutation.target).forEach(trackCurrentRouteTurn);
                }

                for (const node of mutation.addedNodes) {
                    if (nodeContainsTurn(node)) {
                        structural = true;
                        collectTurns(node).forEach(trackCurrentRouteTurn);
                    }
                }

                if (structural) {
                    relevant = true;
                } else if (
                    mutation.type === 'childList' &&
                    queueTurnContentRefresh(mutation.target)
                ) {
                    continue;
                } else if (
                    findKnownUserContentTurn(mutation.target) ||
                    nodeIsWithinMountedThread(mutation.target)
                ) {
                    relevant = true;
                }
            }

            if (removedTurnSnapshots.length && !routeChanged) {
                mergeObservedTurnRecords(removedTurnSnapshots, false);
            }

            if (relevant) {
                invalidateThreadLayout();
                scheduleNativeSnapshotRefresh();
                scheduleRebuild();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            characterData: true,
            attributeFilter: [
                ...STRUCTURE_ATTRIBUTES,
                'aria-expanded',
                'data-state',
                'style',
                'class',
                'hidden'
            ]
        });
    }


    /******************************************************************
     * 初始化
     ******************************************************************/

    function init() {
        console.info('[Conversation Navigator] Started (0.5.4)');
        initializeReplyOutlinePreferences();
        currentChatIdentity = getChatIdentity();
        ensureUI();
        observeRouteChanges();
        observeNewConversationSubmissions();
        observeUserScrollIntent();
        startNativeLocator(currentChatIdentity);
        startNativeAdapter(currentChatIdentity);
        renderTurns();
        observeChatChanges();

        /*
         * ChatGPT 的滚动容器不一定是 window，
         * capture=true 可以捕捉内部滚动容器的 scroll。
         */
        document.addEventListener(
            'scroll',
            () => {
                captureHistoryAnchorAfterUserScroll();
                scheduleActiveUpdate();
                updateReplyTopButton();
            },
            true
        );

        window.addEventListener('resize', () => {
            updateRailDensity();
            scheduleActiveUpdate();
            invalidateThreadLayout();
        });

        /*
         * 低频兜底。
         * ChatGPT 是 SPA + virtualization，
         * 即便某次 DOM 更新模式改变，也能自动恢复。
         */
        startFallbackPolling();
    }

    if (document.readyState === 'loading') {
        document.addEventListener(
            'DOMContentLoaded',
            init,
            { once: true }
        );
    } else {
        init();
    }

})();
