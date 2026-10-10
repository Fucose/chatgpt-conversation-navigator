// ==UserScript==
// @name         ChatGPT Conversation Navigator
// @namespace    https://github.com/Fucose
// @version      0.4.3
// @description  ChatGPT 对话导航：悬停预览、加载完整历史并回到回复顶部。
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

    function createConversationIndex() {
        const entries = [];
        let aliases = new Map();
        let authoritative = false;
        let branchKey = null;
        const suppressed = new Map();
        const committedUserText = new Map();

        function getAliases(entry) {
            const result = new Set();
            if (entry?.identity) result.add(`identity:${entry.identity}`);
            if (entry?.turnKey && entry?.kind) {
                result.add(`turn:${entry.kind}:${entry.turnKey}`);
            }
            const messageIds = [
                entry?.messageId,
                entry?.userMessageId,
                ...(Array.isArray(entry?.userMessageIds)
                    ? entry.userMessageIds
                    : []),
                ...(Array.isArray(entry?.assistantMessageIds)
                    ? entry.assistantMessageIds
                    : [])
            ];
            for (const messageId of messageIds) {
                if (messageId) result.add(`message:${messageId}`);
            }
            return result;
        }

        function rebuildAliases() {
            aliases = new Map();
            for (const entry of entries) {
                for (const alias of getAliases(entry)) {
                    if (!aliases.has(alias)) aliases.set(alias, entry);
                }
            }
        }

        function findMatch(incoming) {
            for (const alias of getAliases(incoming)) {
                const match = aliases.get(alias);
                if (match) return match;
            }
            return null;
        }

        function mergeEntry(previous, incoming, source) {
            const merged = { ...previous };
            const preserveUserText = Boolean(
                committedUserText.has(previous?.identity) ||
                previous?.preserveCommittedUserText
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
                if (key === 'assistantMessageIds') {
                    merged.assistantMessageIds = source === 'snapshot'
                        ? [...new Set(Array.isArray(value) ? value : [])]
                        : Array.from(new Set([
                            ...(Array.isArray(merged.assistantMessageIds)
                                ? merged.assistantMessageIds
                                : []),
                            ...(Array.isArray(value) ? value : [])
                        ]));
                    continue;
                }
                if (value !== '') merged[key] = value;
                else if (!(key in merged)) merged[key] = value;
            }

            if (previous?.identity &&
                (source !== 'snapshot' || !incoming?.identity)) {
                merged.identity = previous.identity;
            }
            if (preserveUserText) merged.preserveCommittedUserText = true;
            return merged;
        }

        function replaceEntries(nextEntries) {
            entries.splice(0, entries.length, ...nextEntries);
            rebuildAliases();
        }

        function resolveEntry(record) {
            rebuildAliases();
            return record?.identity
                ? findMatch(record)
                : null;
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
            rebuildAliases();
            const orderedObserved = [];

            for (const item of incoming) {
                if (!item?.identity) continue;
                let match = findMatch(item);
                if (match) {
                    const merged = mergeEntry(match, item, 'observed');
                    const index = entries.indexOf(match);
                    entries[index] = merged;
                    orderedObserved.push(merged);
                    rebuildAliases();
                    continue;
                }
                if (authoritative && isSuppressed(item)) continue;

                const created = mergeEntry({}, item, 'observed');
                entries.push(created);
                orderedObserved.push(created);
                rebuildAliases();
            }

            if (!authoritative && orderedObserved.length > 1) {
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
            const nextAliases = new Map();
            for (const entry of entries) {
                for (const alias of getAliases(entry)) {
                    if (!nextAliases.has(alias)) nextAliases.set(alias, entry);
                }
            }

            const incomingSuppressed = next.some(isSuppressed);
            if (incomingSuppressed && !branchChanged) {
                return { accepted: false, entries };
            }

            const accepted = [];
            for (const item of next) {
                if (!item?.identity) continue;
                if (isSuppressed(item)) continue;
                let previous = null;
                for (const alias of getAliases(item)) {
                    previous = nextAliases.get(alias);
                    if (previous) break;
                }
                accepted.push(mergeEntry(previous || {}, item, 'snapshot'));
            }

            for (const [identity, retiredAliases] of Array.from(suppressed)) {
                const stillPresent = accepted.some(entry => {
                    const incomingAliases = getAliases(entry);
                    return identity === entry.identity ||
                        Array.from(retiredAliases).some(alias =>
                            incomingAliases.has(alias)
                        );
                });
                if (!stillPresent) suppressed.delete(identity);
            }
            branchKey = nextBranchKey;
            authoritative = true;
            replaceEntries(accepted);
            return { accepted: true, entries };
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
                committedUserText.set(entry.identity, options.userText);
                entry.userText = options.userText;
                entry.userTextSnapshot = options.userText;
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
            resolveEntry,
            hasSnapshot: () => authoritative,
            getBranchKey: () => branchKey,
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
            pagesLoaded: 0,
            message: 'Ready'
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

        async function run(mode = 'start') {
            if (runningPromise) return runningPromise;
            if (typeof readSnapshot !== 'function' ||
                typeof loadPreviousPage !== 'function') {
                state.status = 'error';
                state.hasError = true;
                state.error = new Error('History loader is not configured');
                state.message = state.error.message;
                return getState();
            }

            const id = ++runId;
            const chatIdentity = getChatIdentity();
            stopRequested = false;
            state.status = 'loading';
            state.running = true;
            state.hasError = false;
            state.error = null;
            state.message = mode === 'refresh'
                ? 'Refreshing history…'
                : 'Loading history…';

            const operation = Promise.resolve().then(async () => {
                try {
                    let snapshot = await readSnapshot();
                    if (!isCurrent(id, chatIdentity)) {
                        state.status = 'stale';
                        state.message = 'Conversation changed';
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
                            state.message = !progressed
                                ? 'Stopped: no new history was loaded'
                                : 'Stopped: history pagination repeated a cursor';
                            break;
                        }
                        if (stopRequested) break;
                    }

                    if (!isCurrent(id, chatIdentity)) {
                        state.status = 'stale';
                        state.message = 'Conversation changed';
                    } else if (state.hasError) {
                        state.status = 'error';
                        state.message = state.error?.message || 'History loading failed';
                    } else if (state.complete) {
                        state.status = 'complete';
                        state.message = 'History is complete';
                    } else if (stopRequested && state.status !== 'stopped') {
                        state.status = 'stopped';
                        state.message = 'History loading stopped';
                    } else if (state.status === 'loading') {
                        state.status = 'stopped';
                        state.message = 'History loading paused';
                    }
                    return getState();
                } catch (error) {
                    if (isCurrent(id, chatIdentity)) {
                        state.status = 'error';
                        state.hasError = true;
                        state.error = error;
                        state.message = error?.message || 'History loading failed';
                    } else {
                        state.status = 'stale';
                        state.message = 'Conversation changed';
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
            start: () => run('start'),
            refresh: () => run('refresh'),
            retry: () => run('retry'),
            stop: () => {
                if (!state.running) return false;
                stopRequested = true;
                state.message = 'Stopping after the current page…';
                return true;
            },
            getState
        };
    }

    const { createNativeAdapter, NativeAdapterError } = (() => {
        const NATIVE_MODULE_CONTRACT = Object.freeze({
            scope: Object.freeze({id: 'OW', export: 'a'}),
            conversationState: Object.freeze({id: 'no', export: 'j'}),
            pagination: Object.freeze({id: 'FG', export: 'c'}),
            loader: Object.freeze({id: 'jfi', export: 'b'}),
            reactDom: Object.freeze({id: 'v7', export: 'flushSync'}),
            routeSource: Object.freeze({id: 'Zyh', export: 'ChatGptConversationPage'}),
            historySource: Object.freeze({id: 'M3K', export: 'a'}),
        });

        const MODULE_PRELOAD_SELECTOR = 'link[rel="modulepreload"][href]';
        const REACT_FIBER_PROPERTY_PREFIXES = [
            '__reactFiber$',
            '__reactInternalInstance$',
        ];
        const MAX_PAGE_ELEMENTS = 200_000;
        const MAX_FIBER_NODES_PER_ROOT = 200_000;
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

            let links;
            try {
                links = documentObject.querySelectorAll(MODULE_PRELOAD_SELECTOR);
            } catch (_error) {
                fail('MODULE_PRELOADS_UNAVAILABLE', 'Current ChatGPT module preloads could not be read.');
            }

            const urls = new Set();
            for (const link of Array.from(links || [])) {
                const value = link?.href || link?.getAttribute?.('href');
                const url = asSameOriginAsset(value, windowObject);
                if (url) urls.add(url);
            }

            return urls;
        }

        function getRuntimeCandidates(manifest, documentObject, windowObject) {
            if (!isObject(manifest) || !isObject(manifest.routes)) {
                fail('ROUTER_MANIFEST_UNAVAILABLE', 'The current ChatGPT route manifest is unavailable.');
            }

            const pathname = windowObject.location?.pathname;
            if (typeof pathname !== 'string' || !pathname) {
                fail('CURRENT_ROUTE_UNAVAILABLE', 'The active ChatGPT route could not be identified.');
            }

            const preloads = getModulePreloadUrls(documentObject, windowObject);
            if (preloads.size === 0) {
                fail('MODULE_PRELOADS_UNAVAILABLE', 'No current ChatGPT JavaScript module preloads were found.');
            }

            const routeAssets = getRouteAssets(manifest.routes, pathname);
            if (isObject(manifest.entry) && Array.isArray(manifest.entry.imports)) {
                routeAssets.push(...manifest.entry.imports);
            }

            const counts = new Map();
            for (const asset of routeAssets) {
                const url = asSameOriginAsset(asset, windowObject);
                if (!url || !preloads.has(url)) continue;
                counts.set(url, (counts.get(url) || 0) + 1);
            }

            if (counts.size === 0) {
                fail('CURRENT_RUNTIME_UNAVAILABLE', 'No current route module was present in ChatGPT module preloads.');
            }

            return [...counts.entries()]
                .sort((left, right) => right[1] - left[1])
                .map(([url]) => url);
        }

        function isWebpackRequire(value) {
            return typeof value === 'function' && isObject(value.m);
        }

        async function discoverWebpackRequire({
            document: documentObject,
            window: windowObject,
            importModule,
        }) {
            if (!windowObject || !isObject(windowObject.location)) {
                fail('WINDOW_UNAVAILABLE', 'The current ChatGPT window is unavailable.');
            }

            const manifest = windowObject.__reactRouterManifest;
            const candidates = getRuntimeCandidates(manifest, documentObject, windowObject);
            const importer = typeof importModule === 'function'
                ? importModule
                : specifier => import(specifier);

            for (const url of candidates) {
                let namespace;
                try {
                    namespace = await importer(url);
                } catch (_error) {
                    continue;
                }

                const requireFunction = namespace?.__webpack_require__;
                if (isWebpackRequire(requireFunction)) return requireFunction;
            }

            fail('SUPPORTED_RUNTIME_NOT_FOUND', 'The current ChatGPT runtime does not expose the supported module loader.');
        }

        function requireSupportedModules(requireFunction) {
            const moduleMap = requireFunction.m;
            const requiredIds = Object.values(NATIVE_MODULE_CONTRACT).map(({id}) => id);
            for (const id of requiredIds) {
                if (!Object.prototype.hasOwnProperty.call(moduleMap, id)) {
                    fail('SUPPORTED_MODULES_UNAVAILABLE', 'The current ChatGPT bundle does not contain the supported navigation modules.');
                }
            }

            let exportsByName;
            try {
                exportsByName = Object.fromEntries(
                    Object.entries(NATIVE_MODULE_CONTRACT).map(([name, contract]) => [
                        name,
                        requireFunction(contract.id),
                    ])
                );
            } catch (_error) {
                fail('SUPPORTED_MODULES_UNAVAILABLE', 'The current ChatGPT navigation modules could not be loaded.');
            }

            const scopeToken = exportsByName.scope?.[NATIVE_MODULE_CONTRACT.scope.export];
            const conversationStateSelector = exportsByName.conversationState?.[
                NATIVE_MODULE_CONTRACT.conversationState.export
            ];
            const paginationSelector = exportsByName.pagination?.[
                NATIVE_MODULE_CONTRACT.pagination.export
            ];
            const loadPrevious = exportsByName.loader?.[NATIVE_MODULE_CONTRACT.loader.export];
            const flushSync = exportsByName.reactDom?.[NATIVE_MODULE_CONTRACT.reactDom.export];
            const routeComponent = exportsByName.routeSource?.[
                NATIVE_MODULE_CONTRACT.routeSource.export
            ];
            const historyComponent = exportsByName.historySource?.[
                NATIVE_MODULE_CONTRACT.historySource.export
            ];

            if (
                !isObject(scopeToken) ||
                scopeToken.__scopeBrand !== 'AppScope' ||
                typeof scopeToken.id !== 'symbol' ||
                (!isObject(conversationStateSelector) && typeof conversationStateSelector !== 'function') ||
                paginationSelector == null ||
                typeof loadPrevious !== 'function' ||
                typeof flushSync !== 'function' ||
                typeof routeComponent !== 'function' ||
                typeof historyComponent !== 'function'
            ) {
                fail('SUPPORTED_MODULE_SHAPE_UNKNOWN', 'The current ChatGPT navigation module exports have changed.');
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
            const bindings = new Set();
            for (const fiber of fibers) {
                if (
                    (fiber?.type !== historyComponent && fiber?.elementType !== historyComponent) ||
                    fiber.memoizedProps?.conversationId !== chatId
                ) {
                    continue;
                }

                const wrapper = getCachedScopeWrapper(fiber, scopeToken);
                if (wrapper) bindings.add(wrapper);
            }

            if (bindings.size === 0) return null;
            if (bindings.size > 1) {
                const [first, ...rest] = bindings;
                if (rest.some(binding => binding.node !== first.node || binding.chain !== first.chain)) {
                    fail('AMBIGUOUS_APP_SCOPE_BINDING', 'More than one native AppScope binding matched this conversation.');
                }
                return first;
            }
            return bindings.values().next().value;
        }

        function getConversationStateKey({scope, chatId, modules}) {
            let value;
            try {
                /* Mirrors M3K: DF.x(no.j, conversationId); pagination has a separate fallback. */
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

            if (value == null) {
                fail('NATIVE_PAGINATION_UNINITIALIZED', 'ChatGPT pagination state has not initialized for this conversation.');
            }
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
            const hasError = rawPagination.hasError === true;
            const isLoading = rawPagination.isLoading === true;
            const cursor = rawPagination.cursor ?? null;
            const hasLoadedOlderPages = rawPagination.hasLoadedOlderPages;
            const canUseTerminalCursor = cursor === null &&
                hasLoadedOlderPages === true;
            const complete = !hasError && !isLoading &&
                (rawPagination.complete === true || canUseTerminalCursor);
            const completionReason = hasError
                ? 'error'
                : (isLoading
                    ? 'loading'
                    : (rawPagination.complete
                        ? 'native-complete'
                        : (canUseTerminalCursor
                            ? 'older-pages-exhausted'
                            : (cursor === null
                                ? 'cursor-unproven'
                                : 'cursor-available'))));

            return {
                complete,
                nativeComplete: rawPagination.complete,
                cursor,
                hasError,
                isLoading,
                hasLoadedOlderPages,
                canLoadPrevious: !isLoading && !complete &&
                    typeof cursor === 'string',
                completionReason,
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
                    }
                }

                if (userItems.length === 0 && assistantItems.length === 0) continue;

                const userMessageIds = userItems
                    .map(collectItemMessageId)
                    .filter(Boolean);
                const assistantMessageIds = assistantItems
                    .map(collectItemMessageId)
                    .filter(Boolean);
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
                    assistantText: assistantItems.map(item => item.content).join('\n\n'),
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
                const trees = collectFiberTrees(documentObject);
                const targets = [];
                for (const tree of trees) {
                    const target = findTarget({fibers: tree.fibers, chatId: requestedChatId});
                    if (target) targets.push({tree, target});
                }
                if (targets.length === 0) {
                    fail('ACTIVE_CONVERSATION_NOT_FOUND', 'The native conversation list for this chat is unavailable.');
                }
                if (targets.length > 1) {
                    fail('AMBIGUOUS_ACTIVE_CONVERSATION', 'More than one native conversation list matched this chat.');
                }

                const {tree, target} = targets[0];
                const scope = findAppScopeBinding({
                    fibers: tree.fibers,
                    chatId: requestedChatId,
                    historyComponent: modules.historyComponent,
                    scopeToken: modules.scopeToken,
                });
                if (!scope) {
                    fail('APP_SCOPE_BINDING_UNAVAILABLE', 'The native AppScope binding for this conversation is unavailable.');
                }
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
                    target,
                    scope,
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

            async function waitForPaginationIdle(scope, conversationStateKey, baseline) {
                const setTimer = getCurrentTimer();
                const startedAt = Date.now();
                while (true) {
                    assertActive();
                    const current = resolveCurrentState();
                    if (current.scope !== scope || current.conversationStateKey !== conversationStateKey) {
                        fail('STALE_NATIVE_ADAPTER', 'The active ChatGPT conversation changed during page loading.');
                    }

                    const pagination = current.pagination;
                    const entriesAdvanced = current.target.props.entries.length > baseline.entryCount;
                    const cursorAdvanced = pagination.cursor !== baseline.cursor;
                    const completionChanged = pagination.complete !== baseline.complete;
                    const loadFailed = pagination.hasError && baseline.hasError !== true;
                    const progressed = entriesAdvanced || cursorAdvanced || completionChanged || loadFailed;

                    if (!pagination.isLoading) {
                        if (progressed) return;
                        fail('NATIVE_PAGE_NO_PROGRESS', 'ChatGPT finished the page request without advancing its conversation history.');
                    }
                    if (Date.now() - startedAt >= PAGE_LOAD_WAIT_MS) {
                        fail('NATIVE_PAGE_LOAD_TIMEOUT', 'ChatGPT did not finish loading the previous page in time.');
                    }
                    await new Promise(resolve => setTimer(resolve, PAGE_LOAD_POLL_MS));
                }
            }

            async function performLoadPreviousPage() {
                const {
                    target,
                    scope,
                    conversationStateKey,
                    rawPagination,
                    pagination
                } = resolveCurrentState();
                if (pagination.complete) {
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
                    await waitForPaginationIdle(scope, conversationStateKey, baseline);
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

                await waitForPaginationIdle(scope, conversationStateKey, baseline);
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

            async function locateMessage(messageId) {
                assertActive();
                if (typeof messageId !== 'string' || messageId.length === 0) {
                    fail('INVALID_MESSAGE_ID', 'A message identifier is required.');
                }

                const {target} = resolveCurrentState();
                const entries = target.props.entries;
                const hasMessage = entries.some(entry =>
                    Array.isArray(entry?.turn?.messageIds) &&
                    entry.turn.messageIds.includes(messageId)
                );
                if (!hasMessage) return false;

                try {
                    await target.ref.scrollToMessage(messageId);
                } catch (_error) {
                    fail('NATIVE_SCROLL_FAILED', 'ChatGPT could not scroll to the requested message.');
                }
                return true;
            }

            const adapter = {
                readSnapshot,
                loadPreviousPage,
                locateMessage,
                dispose() {
                    disposed = true;
                },
            };

            /* Fail during construction when the current route or native model is stale. */
            adapter.readSnapshot();
            return adapter;
        }
        return { createNativeAdapter, NativeAdapterError };
    })();
    const core = { createConversationIndex, createHistoryLoader, createNativeAdapter, NativeAdapterError };
    if (typeof module === 'object' && module?.exports &&
        typeof document === 'undefined') {
        module.exports = core;
        return;
    }
    'use strict';

    const RAIL_ID = 'yw-chatgpt-turn-rail';
    const PREVIEW_ID = 'yw-chatgpt-turn-preview';
    const STYLE_ID = 'yw-chatgpt-turn-nav-style';
    const RETRYABLE_NATIVE_BINDING_CODES = new Set([
        'ACTIVE_CONVERSATION_NOT_FOUND',
        'APP_SCOPE_BINDING_UNAVAILABLE',
        'NATIVE_PAGINATION_UNINITIALIZED'
    ]);
    const isRetryableNativeBindingError = error =>
        RETRYABLE_NATIVE_BINDING_CODES.has(error?.code);
    const ASSISTANT_UNIT_SELECTOR =
        '[data-content-search-unit-key$=":assistant"], ' +
        '[data-chatgpt-search-unit-key*="assistant"]';
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

    let turns = [];
    let turnSignature = '';
    let activeIndex = -1;
    let turnRecordsByChat = new Map();
    let conversationIndexesByChat = new Map();
    let mountedTurnsByIdentity = new Map();
    let activeJumpSearch = null;
    let nativeAdapter = null;
    let historyLoader = null;
    let nativeAdapterError = null;
    let adapterConnecting = false;
    let nativeAdapterEpoch = 0;
    let nativeSnapshotTimer = null;
    let latestNativePaginationComplete = null;
    let nativeAdapterRetryPending = false;
    let lastNativeAdapterRetryAt = 0;
    let scrollCoordinatorResizeObserver = null;
    let threadResizeObserver = null;
    let threadResizeObservedNodes = new Set();
    let userScrollGeneration = 0;
    let pendingUserScrollAnchor = false;
    let pendingUserScrollAnchorFrame = null;
    let activeHistoryAnchor = null;
    let extendedScrollRange = null;

    let rebuildTimer = null;
    let activeRAF = null;
    let hideTimer = null;

    let currentChatIdentity = null;
    let turnIdentitiesByChat = new Map();
    let chatOwnersByTurnIdentity = new Map();
    let userEditCandidates = new Map();
    let fallbackTurnOwnersByNode = new WeakMap();
    let assistantIdentitiesByNode = new WeakMap();
    let newConversationSubmissionPending = false;
    let newConversationSubmissionTimer = null;
    let assistantLabelRefreshTimer = null;
    let pendingAssistantLabelUnits = new Map();
    let railDensityCacheKey = '';
    let railLayoutSignature = '';

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
                fill: currentColor;
                stroke: none;
                transform: rotate(180deg);
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
                        rgba(255, 255, 255, 0.97)
                    );

                color: var(--text-primary, #171717);

                border: 1px solid
                    color-mix(
                        in srgb,
                        var(--text-primary, #111) 10%,
                        transparent
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

                color: var(--text-primary, #171717);

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
                        var(--text-primary, #171717) 62%,
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
        `;

        (document.head || document.documentElement).appendChild(style);
    }


    /******************************************************************
     * 创建 UI
     ******************************************************************/

    function getNativeScrollToBottomButton() {
        return document.querySelector('button[aria-label="滚动到底部"]') ||
            document.querySelector('button[class*="scroll-to-bottom"]');
    }

    function syncReplyTopButtonIcon() {
        if (!replyTopButton) return;
        const nativeSvg = getNativeScrollToBottomButton()?.querySelector('svg');
        const nativeUse = nativeSvg?.querySelector('use');
        const nativeHref = nativeUse?.getAttribute('href') ||
            nativeUse?.getAttributeNS('http://www.w3.org/1999/xlink', 'href') || '';
        const signature = nativeSvg
            ? [
                nativeSvg.getAttribute('viewBox') || '',
                nativeHref,
                nativeSvg.getAttribute('class') || '',
                nativeSvg.getAttribute('style') || '',
                nativeSvg.innerHTML
            ].join('|')
            : 'local-arrow-up';
        if (
            replyTopButton.dataset.iconSignature === signature &&
            replyTopButton.querySelector('svg')
        ) {
            return;
        }

        let svg;
        if (nativeSvg) {
            svg = nativeSvg.cloneNode(true);
            svg.removeAttribute('tabindex');
            svg.setAttribute('viewBox', nativeSvg.getAttribute('viewBox') || '0 0 20 20');
            svg.setAttribute('width', '20');
            svg.setAttribute('height', '20');
        } else {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = '<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path d="M10 4v12m-5-5 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
            svg = wrapper.firstElementChild;
        }
        svg.setAttribute('aria-hidden', 'true');
        svg.removeAttribute('focusable');
        replyTopButton.replaceChildren(svg);
        replyTopButton.dataset.iconSignature = signature;
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

        if (!barList || !rail.contains(barList)) {
            barList = document.createElement('div');
            barList.className = 'yw-turn-list';
            barList.setAttribute('aria-label', 'Conversation turns');
            rail.appendChild(barList);
        }

        if (!rail.isConnected) document.body.appendChild(rail);

        if (!replyTopButton || !replyTopButton.isConnected) {
            replyTopButton = document.createElement('button');
            replyTopButton.type = 'button';
            replyTopButton.className = 'yw-reply-top';
            replyTopButton.hidden = true;
            replyTopButton.setAttribute('aria-label', '回到当前回复顶部');
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
        replyTopButton.removeAttribute('title');
        syncReplyTopButtonIcon();

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

    function updateHistoryControl() {
        if (!historyControl) return;
        const status = document.getElementById(`${RAIL_ID}-status`);
        const state = historyLoader?.getState();
        const chatOpen = Boolean(getNativeConversationId());
        const indexedCount = currentChatIdentity
            ? getConversationIndex(currentChatIdentity).getEntries().length
            : 0;
        const countLabel = `当前已索引 ${indexedCount} 轮`;
        const complete = latestNativePaginationComplete === true;
        let label = `加载全部历史（${countLabel}）`;
        let title = label;
        let disabled = Boolean(adapterConnecting);
        const busy = Boolean(adapterConnecting || state?.running);

        if (state?.running) {
            label = '停止加载历史';
            title = `正在加载历史；点击停止（${countLabel}）`;
        } else if ((state?.status === 'error' || nativeAdapterError) && chatOpen) {
            const error = state?.error || nativeAdapterError;
            const code = String(error?.code || 'HISTORY_LOAD_FAILED').slice(0, 48);
            label = '重试加载历史';
            title = `加载失败（${code}），点击重试。`;
        } else if (!chatOpen) {
            disabled = true;
            title = label;
        } else if (state?.status === 'stopped') {
            label = '继续加载历史';
            title = `继续加载历史（${countLabel}）`;
        }

        historyControl.hidden = !turns.length || !chatOpen || complete;
        const toolbar = rail?.querySelector('.yw-nav-toolbar');
        if (toolbar) toolbar.hidden = historyControl.hidden;
        historyControl.disabled = disabled;
        historyControl.classList.toggle('yw-history-loading', Boolean(state?.running));
        historyControl.setAttribute('aria-busy', String(busy));
        historyControl.setAttribute('aria-label', label);
        historyControl.removeAttribute('title');
        if (status && (!status.firstElementChild || status.textContent !== title)) {
            const text = document.createElement('span');
            text.className = 'yw-history-tooltip-text';
            for (const part of title.split(/(（[^（）]*）)/u)) {
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
                    return historyLoader.start();
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
            updateHistoryControl();
            return;
        }
        const operation = state.status === 'complete'
            ? historyLoader.refresh()
            : (state.status === 'error' || nativeAdapterError
                ? historyLoader.retry()
                : historyLoader.start());
        updateHistoryControl();
        Promise.resolve(operation).finally(updateHistoryControl);
    }

    function retryNativeAdapterBinding() {
        if (
            !nativeAdapterRetryPending ||
            adapterConnecting ||
            nativeAdapterError ||
            !getNativeConversationId(currentChatIdentity) ||
            Date.now() - lastNativeAdapterRetryAt < 1000
        ) {
            return;
        }
        lastNativeAdapterRetryAt = Date.now();
        if (nativeAdapter && historyLoader) {
            nativeAdapterRetryPending = false;
            scheduleNativeSnapshotRefresh();
            return;
        }
        if (nativeAdapter || historyLoader) return;
        startNativeAdapter(currentChatIdentity, { automaticRetry: true });
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
        try {
            adapter?.dispose?.();
        } catch (error) {
            console.warn('[Conversation Navigator] Adapter cleanup failed', error);
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
        if (manual) nativeAdapterRetryPending = false;
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
                typeof adapter.loadPreviousPage !== 'function' ||
                typeof adapter.locateMessage !== 'function'
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
            nativeAdapterRetryPending = false;
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
            updateHistoryControl();
        } catch (error) {
            if (
                epoch === nativeAdapterEpoch &&
                chatIdentity === currentChatIdentity
            ) {
                adapterConnecting = false;
                nativeAdapterRetryPending = !manual &&
                    isRetryableNativeBindingError(error);
                nativeAdapterError = nativeAdapterRetryPending ? null : error;
                try {
                    nativeAdapter?.dispose?.();
                } catch (_) {}
                nativeAdapter = null;
                historyLoader = null;
                if (manual) {
                    const code = String(error?.code || 'HISTORY_LOAD_FAILED').slice(0, 48);
                    console.warn(`[Conversation Navigator] History loading failed (${code})`);
                }
                updateHistoryControl();
            }
        }
    }

    function rememberTurnIdentity(chatIdentity, turnIdentity) {
        if (!chatIdentity || !turnIdentity) return;

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
            return owner && owner !== chatIdentity;
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

        const sourceStore = turnRecordsByChat.get(fromIdentity);
        if (!sourceStore) return;

        const targetStore = getTurnRecordStore(toIdentity);
        targetStore.index.upsertObserved(sourceStore.index.getEntries());
        if (sourceStore.index.hasSnapshot()) {
            targetStore.index.applySnapshot({
                chatId: toIdentity.slice('conversation:'.length),
                branchKey: sourceStore.index.getBranchKey(),
                entries: sourceStore.index.getEntries(),
                pagination: { complete: false, cursor: null, hasError: false }
            });
        }
        for (const record of sourceStore.turns) {
            if (targetStore.byIdentity.has(record.identity)) continue;
            targetStore.byIdentity.set(record.identity, record);
            insertTurnRecord(targetStore.turns, record);
        }

        for (const [assistantIdentity, userIdentity] of
            sourceStore.pairedAssistantToUser
        ) {
            if (!targetStore.pairedAssistantToUser.has(assistantIdentity)) {
                targetStore.pairedAssistantToUser.set(
                    assistantIdentity,
                    userIdentity
                );
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
        conversationIndexesByChat.delete(fromIdentity);
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
        railDensityCacheKey = '';
        railLayoutSignature = '';

        if (preview) {
            preview.classList.remove('yw-visible');
        }

        if (previewUser) previewUser.textContent = '';
        if (previewAssistant) previewAssistant.textContent = '';
    }

    function handleRouteChange() {
        const identity = getChatIdentity();

        if (currentChatIdentity === null) {
            currentChatIdentity = identity;
            return;
        }

        if (identity === currentChatIdentity) return;

        cancelJumpSearch();
        userEditCandidates.clear();
        latestNativePaginationComplete = null;
        nativeAdapterRetryPending = false;
        lastNativeAdapterRetryAt = 0;

        /* 根页刚提交 composer 后生成的 /c/<id> 才保留当前新对话。 */
        if (
            newConversationSubmissionPending &&
            isConversationUrlPromotion(currentChatIdentity, identity)
        ) {
            transferChatTurnIdentities(currentChatIdentity, identity);
            currentChatIdentity = identity;
            clearNewConversationSubmission();
            startNativeAdapter(identity);
            return;
        }

        clearNewConversationSubmission();
        currentChatIdentity = identity;

        if (rebuildTimer !== null) {
            clearTimeout(rebuildTimer);
            rebuildTimer = null;
        }

        clearNavigation();
        startNativeAdapter(identity);
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

            const rawStableIdentity =
                root.getAttribute('data-turn-key') ||
                root.getAttribute('data-content-search-turn-key') ||
                bubble.getAttribute('data-chatgpt-search-message-ids');
            const fallbackKey = `turn-${userTurns.length}`;
            const stableIdentity = rawStableIdentity
                ? `user:${rawStableIdentity}`
                : '';
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

    function getAssistantUnitIdentity(assistantUnit) {
        const rawUnitIdentity =
            assistantUnit.getAttribute('data-content-search-unit-key') ||
            assistantUnit.getAttribute('data-chatgpt-search-unit-key') ||
            '';
        if (!rawUnitIdentity) return '';

        const previous = assistantIdentitiesByNode.get(assistantUnit);
        if (
            !assistantUnit.isConnected &&
            previous?.rawUnitIdentity === rawUnitIdentity
        ) {
            return previous.identity;
        }

        const logicalWrapper = getLogicalTurnWrapper(assistantUnit);
        const logicalTurnKey = getTurnWrapperKey(logicalWrapper);
        if (logicalTurnKey) {
            const identity = `round:${JSON.stringify([
                logicalTurnKey,
                rawUnitIdentity
            ])}`;
            assistantIdentitiesByNode.set(assistantUnit, {
                rawUnitIdentity,
                identity
            });
            return identity;
        }

        return rawUnitIdentity;
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

    function getAssistantText(turn) {
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
        if (!conversationIndexesByChat.has(chatIdentity)) {
            conversationIndexesByChat.set(
                chatIdentity,
                createConversationIndex()
            );
        }
        return conversationIndexesByChat.get(chatIdentity);
    }

    function getTurnMessageIds(turn) {
        const splitIds = value => String(value || '')
            .split(/\s+/)
            .map(id => id.trim())
            .filter(Boolean);
        const userIds = splitIds(
            turn?.userBubble?.getAttribute('data-chatgpt-search-message-ids') ||
            turn?.userBubble?.getAttribute('data-message-id')
        );
        const assistantIds = [];
        const assistantUnits = turn?.kind === 'user'
            ? getPairedAssistantUnits(turn)
            : [turn?.assistantUnit || turn?.root].filter(Boolean);
        for (const unit of assistantUnits) {
            if (unit.matches?.('[data-chatgpt-selection-message-id]')) {
                assistantIds.push(
                    unit.getAttribute('data-chatgpt-selection-message-id')
                );
            }
            for (const message of unit.querySelectorAll?.(
                '[data-chatgpt-selection-message-id]'
            ) || []) {
                assistantIds.push(
                    message.getAttribute('data-chatgpt-selection-message-id')
                );
            }
        }
        const cleanAssistantIds = Array.from(new Set(assistantIds.filter(Boolean)));
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

    function toIndexRecord(turn) {
        const messageIds = getTurnMessageIds(turn);
        return {
            identity: turn.identity,
            turnKey: turn.turnKey || getTurnWrapperKey(turn.root),
            kind: turn.kind,
            userMessageId: turn.userMessageId || messageIds.userMessageId,
            userMessageIds: turn.userMessageIds || messageIds.userMessageIds,
            messageId: turn.messageId || messageIds.messageId,
            assistantMessageIds: turn.assistantMessageIds ||
                messageIds.assistantMessageIds,
            userText: turn.userText || getUserText(turn),
            assistantText: turn.assistantText || getAssistantText(turn),
            userTextSnapshot: turn.userTextSnapshot,
            domUserTextBaseline: turn.domUserTextBaseline,
            preserveCommittedUserText: turn.preserveCommittedUserText
        };
    }

    function getTurnRecordStore(chatIdentity) {
        if (!turnRecordsByChat.has(chatIdentity)) {
            turnRecordsByChat.set(chatIdentity, {
                turns: [],
                byIdentity: new Map(),
                pairedAssistantToUser: new Map(),
                suppressedRemovedIdentities: new Map(),
                index: getConversationIndex(chatIdentity),
                nativeBranchKey: null
            });
        }

        return turnRecordsByChat.get(chatIdentity);
    }

    function makeTurnRecord(entry) {
        return {
            identity: entry.identity,
            kind: entry.kind,
            stableIdentity: true,
            turnKey: entry.turnKey || '',
            userMessageId: entry.userMessageId || '',
            userMessageIds: Array.isArray(entry.userMessageIds)
                ? [...entry.userMessageIds]
                : [],
            messageId: entry.messageId || '',
            assistantMessageIds: Array.isArray(entry.assistantMessageIds)
                ? [...entry.assistantMessageIds]
                : [],
            root: null,
            userBubble: null,
            assistantUnit: null,
            userText: entry.userText || '',
            userTextSnapshot: entry.userTextSnapshot || '',
            domUserTextBaseline: typeof entry.domUserTextBaseline === 'string'
                ? entry.domUserTextBaseline
                : null,
            assistantText: entry.assistantText || '',
            preserveCommittedUserText: Boolean(entry.preserveCommittedUserText)
        };
    }

    function applyNativeSnapshot(snapshot, chatIdentity = currentChatIdentity) {
        if (
            !snapshot ||
            chatIdentity !== currentChatIdentity ||
            getChatIdentity() !== chatIdentity
        ) {
            return false;
        }

        const routeChatId = chatIdentity.startsWith('conversation:')
            ? chatIdentity.slice('conversation:'.length)
            : null;
        if (
            snapshot.chatId && routeChatId &&
            snapshot.chatId !== routeChatId &&
            snapshot.chatId !== chatIdentity
        ) {
            return false;
        }

        const store = getTurnRecordStore(chatIdentity);
        const result = store.index.applySnapshot(snapshot);
        if (!result.accepted) return false;

        const nextRecords = [];
        for (const entry of store.index.getEntries()) {
            let record = store.byIdentity.get(entry.identity);
            if (!record) {
                record = Array.from(store.byIdentity.values()).find(candidate =>
                    store.index.resolveEntry(toIndexRecord(candidate)) === entry
                );
            }
            if (!record) {
                record = makeTurnRecord(entry);
                store.byIdentity.set(record.identity, record);
            }

            record.kind = entry.kind;
            record.turnKey = entry.turnKey || record.turnKey || '';
            record.userMessageId = entry.userMessageId || record.userMessageId || '';
            record.userMessageIds = Array.isArray(entry.userMessageIds)
                ? [...entry.userMessageIds]
                : record.userMessageIds || [];
            record.messageId = entry.messageId || record.messageId || '';
            record.assistantMessageIds = [...(entry.assistantMessageIds || [])];
            if (entry.userText && !record.preserveCommittedUserText) {
                record.userText = entry.userText;
            }
            if (entry.assistantText) record.assistantText = entry.assistantText;
            nextRecords.push(record);
        }

        store.turns.splice(0, store.turns.length, ...nextRecords);
        store.nativeBranchKey = snapshot.branchKey ?? store.nativeBranchKey;
        return true;
    }

    function acceptNativeSnapshot(snapshot, chatIdentity = currentChatIdentity) {
        if (!applyNativeSnapshot(snapshot, chatIdentity)) return false;
        if (chatIdentity === currentChatIdentity) {
            nativeAdapterRetryPending = false;
            latestNativePaginationComplete =
                snapshot?.pagination?.complete === true;
            renderTurns();
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
                    if (isRetryableNativeBindingError(error)) {
                        nativeAdapterRetryPending = true;
                        nativeAdapterError = null;
                    } else {
                        nativeAdapterError = error;
                    }
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
        const assistantText = getAssistantText(observed);
        if (
            observed.kind === 'user' &&
            observed.userBubble &&
            (
                liveObservation ||
                (!record.preserveCommittedUserText && !record.userTextSnapshot)
            )
        ) {
            record.userTextSnapshot = fullUserText;
            record.domUserTextBaseline = fullUserText;
            if (userText) record.userText = userText;
            if (liveObservation) record.preserveCommittedUserText = false;
        }
        if (
            assistantText &&
            (liveObservation || (!liveRecord && !record.assistantText))
        ) {
            record.assistantText = assistantText;
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

        record.turnKey = getTurnWrapperKey(record.root) || record.turnKey || '';
        Object.assign(record, getTurnMessageIds(observed));
    }

    function asElement(node) {
        return node instanceof Element ? node : node?.parentElement || null;
    }

    function findKnownUserTurnContainingNode(node) {
        const element = asElement(node);
        if (!element || !currentChatIdentity) return null;

        const store = turnRecordsByChat.get(currentChatIdentity);
        const wrapper = getLogicalTurnWrapper(element);
        const bubble = element.closest('[data-user-message-bubble="true"]');
        const rawIdentity = getTurnWrapperKey(wrapper) ||
            bubble?.getAttribute('data-chatgpt-search-message-ids');
        const record = rawIdentity
            ? store?.byIdentity.get(`user:${rawIdentity}`)
            : null;
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
        const pivotIndex = store?.turns.findIndex(record =>
            record.identity === turn.identity
        ) ?? -1;
        const record = store?.byIdentity.get(turn.identity);
        if (!record || pivotIndex < 0) return;

        let candidate = userEditCandidates.get(turn.identity);
        if (!candidate) {
            let previousUserIdentity = null;
            for (let index = pivotIndex - 1; index >= 0; index--) {
                if (store.turns[index].kind === 'user') {
                    previousUserIdentity = store.turns[index].identity;
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
        const boundary = store.turns.findIndex(record =>
            record.identity === identity
        );
        if (boundary < 0) return null;

        const retainedIdentity = keepPivot ? identity : replacementIdentity;
        const keepRecord = retainedIdentity
            ? store.byIdentity.get(retainedIdentity)
            : null;
        store.index.pruneFrom(identity, {
            keepIdentity: keepPivot,
            userText: keepPivot
                ? (keepRecord?.userTextSnapshot || keepRecord?.userText || '')
                : undefined
        });
        const removedRecords = store.turns.slice(boundary).filter(record =>
            record !== keepRecord
        );
        const removedIdentities = new Set(
            removedRecords.map(record => record.identity)
        );

        if (keepPivot && keepRecord) {
            keepRecord.preserveCommittedUserText = true;
            keepRecord.assistantText = '';
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

        const retainedPrefix = store.turns.slice(0, boundary).filter(record =>
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

    function mergeObservedTurnRecords(
        observedTurns,
        replaceNodeReferences,
        alreadyTracked = false,
        allowBranchReconciliation = false
    ) {
        if (!currentChatIdentity) return;

        const store = getTurnRecordStore(currentChatIdentity);
        if (!store.suppressedRemovedIdentities) {
            store.suppressedRemovedIdentities = new Map();
        }

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

        enforceObservedTurnOrder(store.turns, observed);

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

        store.index.upsertObserved(store.turns.map(toIndexRecord));
    }

    function buildRenderedTurns(observedTurns) {
        const store = getTurnRecordStore(currentChatIdentity);
        const rendered = store.index.getEntries().map(entry => {
            const record = store.byIdentity.get(entry.identity) ||
                store.turns.find(candidate =>
                    store.index.resolveEntry(toIndexRecord(candidate)) === entry
                );
            const mounted = mountedTurnsByIdentity.get(entry.identity);
            return {
                ...(record || {}),
                ...entry,
                root: mounted?.root || record?.root || null,
                userBubble: mounted?.userBubble || record?.userBubble || null,
                assistantUnit: mounted?.assistantUnit || record?.assistantUnit || null,
                stableIdentity: true
            };
        });
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
            ? turn.assistantText || ''
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
        if (desiredTop <= maxScrollTop) return maxScrollTop;

        const originalValue = container.style.getPropertyValue('padding-bottom');
        const originalPriority = container.style.getPropertyPriority('padding-bottom');
        const computedPadding = parseFloat(
            window.getComputedStyle(container).paddingBottom
        ) || 0;
        const appliedPadding = computedPadding + desiredTop - maxScrollTop + 2;

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
                if (rail?.contains(event.target)) return;
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
        return Boolean(
            search &&
            activeJumpSearch === search &&
            !search.cancelled &&
            currentChatIdentity === search.chatIdentity &&
            getChatIdentity() === search.chatIdentity &&
            (
                turns.some(turn => turn.identity === search.identity) ||
                getConversationIndex(search.chatIdentity)
                    .getEntries()
                    .some(entry => entry.identity === search.identity)
            )
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
        const viewportTop = scrollContext.viewportTop;
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
            '[data-user-message-bubble="true"][data-chatgpt-search-message-ids], ' +
            '[data-user-message-bubble="true"][data-message-id]'
        )) {
            const ids = String(
                element.getAttribute('data-chatgpt-search-message-ids') ||
                element.getAttribute('data-message-id') ||
                ''
            ).split(/\s+/);
            if (ids.includes(messageId)) return element;
        }
        return null;
    }

    function findCurrentTurn(identity) {
        return turns.find(turn => turn.identity === identity) || null;
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
            if (
                unit.matches?.('[data-chatgpt-selection-message-id]') &&
                unit.getAttribute('data-chatgpt-selection-message-id') === messageId
            ) {
                return unit;
            }
            for (const candidate of unit.querySelectorAll?.(
                '[data-chatgpt-selection-message-id]'
            ) || []) {
                if (
                    candidate.getAttribute('data-chatgpt-selection-message-id') ===
                    messageId
                ) {
                    return candidate;
                }
            }
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

    async function waitForMountedMessage(search, messageId, timeoutMs = 12000) {
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
            correctionFrame: null,
            settled: false
        };
        activeJumpSearch = search;

        try {
            let target = search.messageId
                ? findMountedMessageForEntry(entry, search.messageId)
                : getMountedTarget(entry, options);

            if (!target && search.messageId && nativeAdapter) {
                const located = await nativeAdapter.locateMessage(search.messageId);
                if (!located || !isCurrentJumpSearch(search)) {
                    clearForegroundSearch(search);
                    return;
                }
                target = await waitForMountedMessage(search, search.messageId);
            }
            if (!target?.isConnected || !isCurrentJumpSearch(search)) {
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
                console.warn('[Conversation Navigator] Navigation failed', error);
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
        for (const element of document.querySelectorAll(
            '[data-chatgpt-selection-message-id], ' +
            '[data-user-message-bubble="true"][data-chatgpt-search-message-ids], ' +
            '[data-user-message-bubble="true"][data-message-id]'
        )) {
            if (!element.isConnected) continue;
            const ids = element.hasAttribute('data-chatgpt-selection-message-id')
                ? [element.getAttribute('data-chatgpt-selection-message-id')]
                : String(
                    element.getAttribute('data-chatgpt-search-message-ids') ||
                    element.getAttribute('data-message-id') ||
                    ''
                ).split(/\s+/);
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

    async function waitForReadingAnchorTarget(anchor, adapterEpoch, timeoutMs = 1200) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (
                anchor.chatIdentity !== currentChatIdentity ||
                anchor.userScrollGeneration !== userScrollGeneration ||
                adapterEpoch !== nativeAdapterEpoch
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
        if (!target && nativeAdapter && anchor.messageId) {
            const adapter = nativeAdapter;
            const adapterEpoch = nativeAdapterEpoch;
            await adapter.locateMessage(anchor.messageId);
            if (adapter !== nativeAdapter || adapterEpoch !== nativeAdapterEpoch) {
                return false;
            }
            target = await waitForReadingAnchorTarget(anchor, adapterEpoch);
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

    function showPreviewByIdentity(identity, bar) {
        const index = turns.findIndex(turn => turn.identity === identity);
        if (index >= 0) showPreview(index, bar);
    }

    async function jumpToTurn(identity) {
        return jumpToIdentity(identity);
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

        const listMaxHeight = Math.max(
            180,
            Math.floor(window.innerHeight * 0.72)
        );
        const available = Math.max(164, listMaxHeight - 16);

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
        handleRouteChange();
        ensureUI();

        const observedTurns = collectTurns().filter(trackCurrentRouteTurn);
        mergeObservedTurnRecords(observedTurns, true, true, true);
        const index = getConversationIndex(currentChatIdentity);
        mountedTurnsByIdentity = new Map();
        for (const turn of observedTurns) {
            if (!turn.root?.isConnected) continue;
            const indexedEntry = index.resolveEntry(toIndexRecord(turn));
            mountedTurnsByIdentity.set(indexedEntry?.identity || turn.identity, turn);
        }
        syncThreadResizeTargets(observedTurns);
        const newTurns = buildRenderedTurns(observedTurns);
        const labelSources = new Map();
        for (const turn of observedTurns) {
            const indexedEntry = index.resolveEntry(toIndexRecord(turn));
            labelSources.set(indexedEntry?.identity || turn.identity, turn);
        }

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

    function updateReplyTopButton() {
        if (!replyTopButton) return;
        const readingPointRatio = 0.38;

        for (const turn of turns) {
            const mounted = mountedTurnsByIdentity.get(turn.identity) || turn;
            const reply = getAssistantReplyTarget(mounted);
            if (!reply?.isConnected) continue;

            const rect = reply.getBoundingClientRect();
            if (!rect.width || !rect.height) continue;
            const context = createScrollContext(reply);
            const viewportHeight = context.isDocumentScroll
                ? window.innerHeight
                : context.container.clientHeight;
            const readingY = context.viewportTop +
                viewportHeight * readingPointRatio;
            const headerInset = getFixedHeaderInset(reply, context);
            const readingEdge = context.viewportTop + headerInset;

            if (
                rect.top >= readingEdge ||
                rect.top > readingY ||
                rect.bottom < readingY
            ) {
                continue;
            }

            const messageIds = getTurnMessageIds(mounted);
            const messageId = turn.kind === 'assistant'
                ? (turn.messageId || messageIds.messageId)
                : (turn.assistantMessageIds?.[0] ||
                    messageIds.assistantMessageIds[0] || '');
            replyTopButton.dataset.identity = turn.identity;
            if (messageId) {
                replyTopButton.dataset.messageId = messageId;
            } else {
                delete replyTopButton.dataset.messageId;
            }
            replyTopButton.style.left = `${rect.left + rect.width / 2}px`;
            replyTopButton.style.top = `${context.viewportTop + 24}px`;
            replyTopButton.hidden = false;
            return;
        }

        replyTopButton.hidden = true;
        delete replyTopButton.dataset.identity;
        delete replyTopButton.dataset.messageId;
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

    function scheduleRebuild() {
        clearTimeout(rebuildTimer);

        rebuildTimer = setTimeout(() => {
            renderTurns();
            retryNativeAdapterBinding();
        }, 180);
    }

    function nodeIsWithinMountedThread(node) {
        const element = asElement(node);
        if (!element) return false;
        for (const turn of mountedTurnsByIdentity.values()) {
            const roots = [
                turn.root,
                turn.userBubble,
                turn.assistantUnit,
                ...(turn.pairedAssistantUnits || [])
            ];
            if (roots.some(root =>
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
            const candidates = [
                turn.root,
                turn.userBubble,
                turn.assistantUnit,
                ...(turn.pairedAssistantUnits || [])
            ];
            for (const node of candidates) {
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

        if (node.matches(TURN_NODE_SELECTOR)) return true;

        return Boolean(node.querySelector(TURN_NODE_SELECTOR));
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

    function flushAssistantBarRefreshes() {
        assistantLabelRefreshTimer = null;
        const pending = Array.from(pendingAssistantLabelUnits.values());
        pendingAssistantLabelUnits.clear();
        const observedTurns = collectTurns();

        let refreshed = false;

        for (const { identity, assistantUnit, chatIdentity } of pending) {
            if (
                chatIdentity !== currentChatIdentity ||
                !assistantUnit.isConnected
            ) {
                continue;
            }

            for (let index = 0; index < turns.length; index++) {
                const turn = turns[index];
                const isMatchingAssistant =
                    turn.kind === 'assistant' && turn.identity === identity;
                const containsAssistant =
                    isPairedAssistantUnit(turn, assistantUnit);
                if (!isMatchingAssistant && !containsAssistant) continue;

                const observed = observedTurns.find(candidate =>
                    candidate.identity === turn.identity &&
                    candidate.stableIdentity
                );
                const record = turnRecordsByChat
                    .get(chatIdentity)?.byIdentity.get(turn.identity);
                if (record && observed) {
                    updateTurnRecord(record, observed, true);
                } else if (record) {
                    record.assistantUnit = assistantUnit;
                    record.root = turn.kind === 'assistant'
                        ? assistantUnit.querySelector(
                            '[data-chatgpt-selection-message-id]'
                        ) || assistantUnit
                        : turn.root;
                    const assistantText = getAssistantText(record);
                    if (assistantText) record.assistantText = assistantText;
                } else {
                    turn.assistantUnit = assistantUnit;
                    turn.root = assistantUnit.querySelector(
                        '[data-chatgpt-selection-message-id]'
                    ) || assistantUnit;
                }

                barList?.children[index]?.setAttribute(
                    'aria-label',
                    getTurnBarLabel(turn, index, observed || turn)
                );
                refreshed = true;
            }
        }

        if (refreshed) scheduleActiveUpdate();
    }

    function queueAssistantBarRefresh(node) {
        const element = node instanceof Element ? node : node?.parentElement;
        if (!element) return false;

        const assistantUnit = element.matches(ASSISTANT_UNIT_SELECTOR)
            ? element
            : element.closest(ASSISTANT_UNIT_SELECTOR);
        if (!assistantUnit) return false;

        const unitIdentity = getAssistantUnitIdentity(assistantUnit);
        if (!unitIdentity) return false;

        const identity = `assistant:${unitIdentity}`;
        pendingAssistantLabelUnits.set(identity, {
            identity,
            assistantUnit,
            chatIdentity: currentChatIdentity
        });

        /* 每 250ms 合并一次文本流更新，避免每个字符都读取整段回复。 */
        if (assistantLabelRefreshTimer === null) {
            assistantLabelRefreshTimer = setTimeout(
                flushAssistantBarRefreshes,
                250
            );
        }

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

            let relevant = false;
            const removedTurnSnapshots = [];

            for (const mutation of mutations) {
                /*
                 * 忽略我们自己的导航 UI 修改。
                 */
                if (
                    rail?.contains(mutation.target) ||
                    preview?.contains(mutation.target) ||
                    replyTopButton === mutation.target ||
                    replyTopButton?.contains(mutation.target)
                ) {
                    continue;
                }

                captureUserEditCandidatesFromMutation(mutation);

                if (mutation.type === 'characterData') {
                    queueAssistantBarRefresh(mutation.target);
                    if (
                        findKnownUserContentTurn(mutation.target) ||
                        nodeIsWithinMountedThread(mutation.target)
                    ) {
                        relevant = true;
                    }
                    continue;
                }

                if (
                    mutation.type === 'attributes' &&
                    ['style', 'class', 'hidden'].includes(
                        mutation.attributeName
                    )
                ) {
                    if (visibilityMutationAffectsCurrentChat(mutation.target)) {
                        relevant = true;
                    }
                    continue;
                }

                if (
                    findKnownUserContentTurn(mutation.target) ||
                    nodeIsWithinMountedThread(mutation.target)
                ) {
                    relevant = true;
                }

                for (const node of mutation.removedNodes) {
                    if (nodeContainsTurn(node)) {
                        removedTurnSnapshots.push(...collectTurns(node));
                        relevant = true;
                    }
                }

                if (
                    mutation.type === 'attributes' &&
                    nodeContainsTurn(mutation.target)
                ) {
                    relevant = true;
                }

                for (const node of mutation.addedNodes) {
                    if (nodeContainsTurn(node)) {
                        relevant = true;
                    }
                }

                if (mutation.type === 'childList') {
                    queueAssistantBarRefresh(mutation.target);
                }
            }

            if (removedTurnSnapshots.length && !routeChanged) {
                mergeObservedTurnRecords(removedTurnSnapshots, false);
            }

            if (relevant) {
                collectTurns().forEach(trackCurrentRouteTurn);
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
                'data-turn-key',
                'data-content-search-turn-key',
                'data-user-message-bubble',
                'data-content-search-unit-key',
                'data-chatgpt-search-unit-key',
                'data-conversation-role',
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
        ensureUI();
        currentChatIdentity = getChatIdentity();
        observeRouteChanges();
        observeNewConversationSubmissions();
        observeUserScrollIntent();
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
        setInterval(() => {
            renderTurns();
            retryNativeAdapterBinding();
        }, 2500);
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
