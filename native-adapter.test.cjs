const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const scriptPath = path.join(__dirname, 'chatgpt-conversation-navigator.user.js');
const scriptSource = fs.readFileSync(scriptPath, 'utf8');

function loadCore(fixture) {
    const sandbox = {
        module: {exports: {}}, document: undefined, URL,
        __onFactorySourceRead(factory) {
            if (fixture && fixture.factorySet.has(factory)) fixture.scanCounter.count++;
        }
    };
    vm.runInNewContext(
        'const original = Function.prototype.toString; Function.prototype.toString = function() { globalThis.__onFactorySourceRead(this); return Reflect.apply(original, this, []); };',
        sandbox
    );
    vm.runInNewContext(scriptSource, sandbox, {filename: scriptPath});
    return sandbox.module.exports;
}

const BASE_NAMES = {
    ids: {
        scope: 'OW', state: 'Mr', pagination: 'FG', loader: 'jfi',
        react: 'v7', hooks: 'hooks', history: 'M3K'
    },
    exports: {
        scope: 'a', state: 'j', pagination: 'c', account: 'accountSelector', loader: 'b',
        react: 'flushSync', hookScope: 'useScope', hookValue: 'useValue', history: 'a'
    },
    locals: {
        scopeToken: 'scopeToken', stateSelector: 'conversationStateSelector',
        paginationSelector: 'paginationSelector', accountSelector: 'accountSelector', flushSync: 'flushSync',
        hookScope: 'useScope', hookValue: 'useValue',
        loaderFunction: 'previousPage', componentFunction: 'HistoryComponent',
        scopeDep: 'scopeTokenDep', stateDep: 'stateSelectorDep',
        paginationDep: 'paginationDep', loaderDep: 'loaderDep',
        reactDep: 'reactDep', hooksDep: 'hooksDep',
        scopeValue: 'scope', keyValue: 'key', pageValue: 'page',
        conversationValue: 'conversationId', callbackValue: 'loadPrevious',
        factoryModuleArg: 'module', factoryExportsArg: 'exports', factoryRequireArg: 'require',
        loaderScopeArg: 'scope', loaderCidArg: 'cid', loaderFlushArg: 'flush'
    }
};

function mergeNames(overrides = {}, base = BASE_NAMES) {
    return {
        ids: {...base.ids, ...(overrides.ids || {})},
        exports: {...base.exports, ...(overrides.exports || {})},
        locals: {...base.locals, ...(overrides.locals || {})}
    };
}

function member(alias, name, style) {
    if (style === 'bracket' || !/^[A-Za-z_$][\w$]*$/.test(name)) {
        return alias + '[' + JSON.stringify(name) + ']';
    }
    return alias + '.' + name;
}

function invoke(expression, style) {
    return style === 'babel' ? '(0,' + expression + ')' : expression;
}

function exportStatement(local, name, style, locals) {
    const requireArg = locals.factoryRequireArg;
    const exportsArg = locals.factoryExportsArg;
    if (style === 'namespace') {
        return requireArg + '.d(' + exportsArg + ', {' + JSON.stringify(name) + ': () => ' + local + '});';
    }
    if (style === 'bracket' || !/^[A-Za-z_$][\w$]*$/.test(name)) {
        return exportsArg + '[' + JSON.stringify(name) + '] = ' + local + ';';
    }
    return exportsArg + '.' + name + ' = ' + local + ';';
}

function makeFixture({
    names: namesOverrides = {},
    referenceStyle = 'dot',
    callStyle = 'direct',
    exportStyle = 'direct',
    pagination = {
        complete: false, cursor: 'cursor-1', hasLoadedOlderPages: false,
        hasError: false, isLoading: false, oldestMessageId: 'message-1'
    },
    missingExport = null,
    invalidStateSelector = false,
    decoys = false,
    realShape = false,
    alternateGraph = null,
    routeId = 'chat-1'
} = {}) {
    const names = mergeNames(namesOverrides);
    const chatId = 'chat-1';
    const stateKey = 'state-chat-1';
    const scanCounter = {count: 0};
    const factorySet = new WeakSet();
    const moduleTableStats = {enumerations: 0, factoryReads: new Map()};
    const factoryTable = Object.create(null);
    const moduleMap = new Proxy(factoryTable, {
        ownKeys(target) {
            moduleTableStats.enumerations++;
            return Reflect.ownKeys(target);
        },
        get(target, property, receiver) {
            if (Object.prototype.hasOwnProperty.call(target, property)) {
                moduleTableStats.factoryReads.set(
                    property,
                    (moduleTableStats.factoryReads.get(property) || 0) + 1
                );
            }
            return Reflect.get(target, property, receiver);
        }
    });
    const moduleCache = Object.create(null);
    const values = {
        scopeToken: {__scopeBrand: 'AppScope', id: Symbol('AppScope')},
        stateSelector: invalidStateSelector ? null : function stateSelector() {},
        paginationSelector: function paginationSelector() {},
        accountSelector: function accountSelector() {},
        loadCalls: 0,
        flushCalls: 0,
        unrelatedFactoryExecutions: 0
    };

    function createFactory(body, locals) {
        const factory = new Function(
            locals.factoryModuleArg,
            locals.factoryExportsArg,
            locals.factoryRequireArg,
            body
        );
        factorySet.add(factory);
        return factory;
    }

    function addFactory(id, body, graphNames = names) {
        factoryTable[id] = createFactory(body, graphNames.locals);
    }

    function requireModule(id) {
        if (!Object.prototype.hasOwnProperty.call(moduleMap, id)) throw new Error('Unknown module ' + id);
        if (moduleCache[id]) return moduleCache[id].exports;
        const module = {exports: {}};
        moduleCache[id] = module;
        moduleMap[id](module, module.exports, requireModule);
        return module.exports;
    }

    requireModule.m = moduleMap;
    requireModule.c = moduleCache;
    requireModule.__fixtureValues = values;
    requireModule.d = (exportsObject, definitions) => {
        for (const key of Object.keys(definitions)) {
            if (Object.prototype.hasOwnProperty.call(exportsObject, key)) continue;
            Object.defineProperty(exportsObject, key, {
                enumerable: true, get: definitions[key]
            });
        }
    };

    function addExport(kind, local) {
        if (missingExport === kind) return '';
        return exportStatement(local, names.exports[kind], exportStyle, names.locals);
    }

    const requireArg = names.locals.factoryRequireArg;
    addFactory(names.ids.scope, [
        'const ' + names.locals.scopeToken + ' = ' + requireArg + '.__fixtureValues.scopeToken;',
        addExport('scope', names.locals.scopeToken)
    ].filter(Boolean).join('\n'));
    addFactory(names.ids.state, [
        'const ' + names.locals.stateSelector + ' = ' + requireArg + '.__fixtureValues.stateSelector;',
        addExport('state', names.locals.stateSelector)
    ].filter(Boolean).join('\n'));
    addFactory(names.ids.pagination, [
        'const ' + names.locals.paginationSelector + ' = ' + requireArg + '.__fixtureValues.paginationSelector;',
        'const ' + names.locals.accountSelector + ' = ' + requireArg + '.__fixtureValues.accountSelector;',
        addExport('pagination', names.locals.paginationSelector),
        addExport('account', names.locals.accountSelector)
    ].filter(Boolean).join('\n'));
    addFactory(names.ids.react, [
        'const ' + names.locals.flushSync + ' = function(callback) { ' + requireArg + '.__fixtureValues.flushCalls++; return callback(); };',
        addExport('react', names.locals.flushSync)
    ].filter(Boolean).join('\n'));
    addFactory(names.ids.hooks, [
        'const ' + names.locals.hookScope + ' = function() {};',
        'const ' + names.locals.hookValue + ' = function() {};',
        exportStatement(names.locals.hookScope, names.exports.hookScope, exportStyle, names.locals),
        exportStatement(names.locals.hookValue, names.exports.hookValue, exportStyle, names.locals)
    ].join('\n'), names);

    function makeLoaderBody(graphNames, suffix = '') {
        const l = graphNames.locals;
        const paginationRef = member(l.paginationDep, graphNames.exports.pagination, referenceStyle);
        const accountRef = member(l.paginationDep, graphNames.exports.account, referenceStyle);
        const scopeArg = l.loaderScopeArg, cidArg = l.loaderCidArg, flushArg = l.loaderFlushArg;
        return [
            'const ' + l.paginationDep + ' = ' + l.factoryRequireArg + '(' + JSON.stringify(graphNames.ids.pagination) + ');',
            'async function ' + l.loaderFunction + '(' + scopeArg + ', ' + cidArg + ', ' + flushArg + ') {',
            '    ' + scopeArg + '.get(' + accountRef + ');',
            '    let page = ' + scopeArg + '.get(' + paginationRef + ', ' + cidArg + ');',
            '    if (!page || page.complete || page.isLoading || !page.cursor || !page.oldestMessageId) return null;',
            '    const queryKey = ["chatgpt-conversation-page", ' + cidArg + '];',
            '    const endpoint = "/conversations/{conversation_id}/messages";',
            '    ' + l.factoryRequireArg + '.__fixtureValues.loadCalls++;',
            '    const result = await ' + l.factoryRequireArg + '.__fixtureValues.safeGet(endpoint, {queryKey: queryKey, cursor: page.cursor});',
            '    ' + flushArg + '(() => result);',
            '    return result;',
            '}',
            exportStatement(l.loaderFunction, graphNames.exports.loader, exportStyle, l),
            suffix
        ].join('\n');
    }

    function makeComponentBody(graphNames) {
        const l = graphNames.locals;
        const e = graphNames.exports;
        const ids = graphNames.ids;
        const scopeRef = member(l.scopeDep, e.scope, referenceStyle);
        const stateRef = member(l.stateDep, e.state, referenceStyle);
        const paginationRef = member(l.paginationDep, e.pagination, referenceStyle);
        const loaderRef = member(l.loaderDep, e.loader, referenceStyle);
        const flushRef = member(l.reactDep, e.react, referenceStyle);
        const useScopeRef = member(l.hooksDep, e.hookScope, referenceStyle);
        const useValueRef = member(l.hooksDep, e.hookValue, referenceStyle);

        if (realShape) {
            const req = l.factoryRequireArg;
            const scopeRef = member('l', e.scope, referenceStyle);
            const stateRef = member('u', e.state, referenceStyle);
            const paginationRef = member('p', e.pagination, referenceStyle);
            const loaderRef = member('d', e.loader, referenceStyle);
            const flushRef = member('i', e.react, referenceStyle);
            const useScope = member('h', e.hookScope, referenceStyle);
            const useValue = member('h', e.hookValue, referenceStyle);
            return [
                'const l = ' + req + '(' + JSON.stringify(ids.scope) + ');',
                'const u = ' + req + '(' + JSON.stringify(ids.state) + ');',
                'const p = ' + req + '(' + JSON.stringify(ids.pagination) + ');',
                'const d = ' + req + '(' + JSON.stringify(ids.loader) + ');',
                'const i = ' + req + '(' + JSON.stringify(ids.react) + ');',
                'const h = ' + req + '(' + JSON.stringify(ids.hooks) + ');',
                'function m(e) {',
                '    let t,n,m,v,x=(0,' + useScope + ')( ' + scopeRef + '),{conversationId:b}=e,C=(0,' + useValue + ')(' + stateRef + ',b),_=(0,' + useValue + ')(' + paginationRef + ',C??b);',
                '    m=()=>{ (0,' + loaderRef + ')(x,C,' + flushRef + '); };',
                '    const observer = new IntersectionObserver(() => m());',
                '    return {scope:x,key:C,page:_,observer:observer};',
                '}',
                exportStatement('m', e.history, exportStyle, l)
            ].join('\n');
        }

        return [
            'const ' + l.scopeDep + ' = ' + l.factoryRequireArg + '(' + JSON.stringify(ids.scope) + ');',
            'const ' + l.stateDep + ' = ' + l.factoryRequireArg + '(' + JSON.stringify(ids.state) + ');',
            'const ' + l.paginationDep + ' = ' + l.factoryRequireArg + '(' + JSON.stringify(ids.pagination) + ');',
            'const ' + l.loaderDep + ' = ' + l.factoryRequireArg + '(' + JSON.stringify(ids.loader) + ');',
            'const ' + l.reactDep + ' = ' + l.factoryRequireArg + '(' + JSON.stringify(ids.react) + ');',
            'const ' + l.hooksDep + ' = ' + l.factoryRequireArg + '(' + JSON.stringify(ids.hooks) + ');',
            'function ' + l.componentFunction + '(props) {',
            '    const ' + l.conversationValue + ' = props.conversationId;',
            '    const ' + l.scopeValue + ' = ' + invoke(useScopeRef, callStyle) + '(' + scopeRef + ');',
            '    const ' + l.keyValue + ' = ' + invoke(useValueRef, callStyle) + '(' + stateRef + ', ' + l.conversationValue + ');',
            '    const ' + l.pageValue + ' = ' + invoke(useValueRef, callStyle) + '(' + paginationRef + ', ' + l.keyValue + ' ?? ' + l.conversationValue + ');',
            '    const ' + l.callbackValue + ' = () => ' + invoke(loaderRef, callStyle) + '(' + l.scopeValue + ', ' + l.keyValue + ', ' + flushRef + ');',
            '    const observer = new IntersectionObserver(() => ' + l.callbackValue + '());',
            '    return {scope: ' + l.scopeValue + ', key: ' + l.keyValue + ', page: ' + l.pageValue + ', observer: observer};',
            '}',
            exportStatement(l.componentFunction, e.history, exportStyle, l)
        ].join('\n');
    }

    function addGraph(graphNames, suffix = '') {
        addFactory(graphNames.ids.loader, makeLoaderBody(graphNames, suffix));
        addFactory(graphNames.ids.history, makeComponentBody(graphNames));
    }

    addGraph(names);
    if (alternateGraph) addGraph(mergeNames(alternateGraph, names));

    if (decoys) {
        addFactory('unrelated-throwing-factory', [
            'require.__fixtureValues.unrelatedFactoryExecutions++;',
            'throw new Error("An unrelated factory must not be executed.");'
        ].join('\n'));
        addFactory('comment-and-string-decoy', [
            '// chatgpt-conversation-page',
            'const marker = "/conversations/{conversation_id}/messages";',
            'function disconnected(scope, cid, flush) { return marker + " chatgpt-conversation-page"; }',
            'exports.fake = disconnected;'
        ].join('\n'));
        addFactory('disconnected-loader-decoy', [
            'const ' + names.locals.paginationDep + ' = require(' + JSON.stringify(names.ids.pagination) + ');',
            'async function disconnectedPreviousPage(scope, cid, flush) {',
            '    let page = scope.get(' + member(names.locals.paginationDep, names.exports.pagination, referenceStyle) + ', cid);',
            '    if (!page || !page.cursor || !page.oldestMessageId) return null;',
            '    const queryKey = ["chatgpt-conversation-page", cid];',
            '    const endpoint = "/conversations/{conversation_id}/messages";',
            '    return safeGet(endpoint, {queryKey: queryKey});',
            '}',
            'exports.fakePreviousPage = disconnectedPreviousPage;'
        ].join('\n'));
    }

    const scopeReads = [];
    const scopeNode = {token: values.scopeToken};
    const scope = {
        scope: values.scopeToken,
        node: scopeNode,
        chain: {get: id => id === values.scopeToken.id ? scopeNode : null},
        get(selector, key) {
            scopeReads.push({selector, key});
            if (selector === values.stateSelector && key === chatId) return stateKey;
            if (selector === values.paginationSelector && key === stateKey) return pagination;
            return undefined;
        },
        set() {}, watch() {}, when() {}
    };
    const entries = [{
        id: 'entry-1',
        turnKey: 'turn-1',
        turn: {
            messageIds: ['message-1', 'message-2'],
            items: [
                {type: 'user-message', messageId: 'message-1', message: 'hello'},
                {type: 'assistant-message', messageId: 'message-2', content: 'hi'}
            ]
        }
    }];
    const historyComponent = requireModule(names.ids.history)[names.exports.history];
    const fiber = {
        return: null, sibling: null, child: null,
        type: historyComponent, elementType: historyComponent,
        memoizedProps: {
            conversationId: chatId, entries,
            ref: {current: {scrollToMessage() {}}}
        },
        memoizedState: {memoizedState: {current: scope}, next: null}
    };
    const root = {return: null, child: fiber, sibling: null, stateNode: null};
    root.stateNode = {current: root};
    fiber.return = root;

    values.safeGet = async (endpoint, request) => {
        values.lastRequest = {endpoint, request};
        if (pagination && typeof pagination === 'object') {
            pagination.cursor = null;
            pagination.complete = false;
            pagination.hasLoadedOlderPages = true;
            pagination.isLoading = false;
        }
        entries.unshift({id: 'entry-0', turnKey: 'turn-0', turn: {messageIds: ['message-0'], items: [{type: 'user-message', messageId: 'message-0', message: 'older'}]}});
        return {ok: true};
    };

    const pageElement = {};
    Object.defineProperty(pageElement, '__reactFiber$test', {value: fiber});
    const document = {
        documentElement: pageElement,
        querySelectorAll(selector) {
            if (selector === 'link[rel="modulepreload"][href]') return [];
            if (selector === '*') return [pageElement];
            return [];
        }
    };
    const assetUrl = 'https://chatgpt.com/cdn/assets/conversation.js';
    const importUrls = [];
    const window = {
        location: {
            href: 'https://chatgpt.com/c/' + routeId,
            origin: 'https://chatgpt.com',
            pathname: '/c/' + routeId
        },
        __reactRouterManifest: {
            routes: {
                conversation: {
                    id: 'conversation', path: '/c/:id',
                    imports: ['/cdn/assets/conversation.js']
                }
            }
        },
        performance: {getEntriesByType: () => []},
        setTimeout: (...args) => setTimeout(...args)
    };

    function addUnrelatedFactory(id = 'growth-unrelated-factory') {
        addFactory(id, 'throw new Error("A source-only factory must not be executed.");');
    }

    function replaceSelectedLoaderFactory() {
        addFactory(names.ids.loader, makeLoaderBody(names, '\n/* selected factory replacement */'));
        delete moduleCache[names.ids.loader];
        delete moduleCache[names.ids.history];
        const replacement = requireModule(names.ids.history)[names.exports.history];
        fiber.type = replacement;
        fiber.elementType = replacement;
    }

    return {
        document, window, chatId, stateKey, scopeReads, factorySet,
        stateSelector: values.stateSelector,
        paginationSelector: values.paginationSelector,
        assetUrl, importUrls, values, scanCounter, moduleTableStats,
        moduleMap, moduleCache, webpackRequire: requireModule,
        addUnrelatedFactory, replaceSelectedLoaderFactory
    };
}

function adapterOptions(fixture, chatId = fixture.chatId) {
    return {
        document: fixture.document,
        window: fixture.window,
        importModule: async url => {
            fixture.importUrls.push(url);
            return {__webpack_require__: fixture.webpackRequire};
        },
        chatId
    };
}

async function assertReadableAdapter(fixture) {
    const core = loadCore(fixture);
    const adapter = await core.createNativeAdapter(adapterOptions(fixture));
    const snapshot = adapter.readSnapshot();

    assert.equal(snapshot.chatId, fixture.chatId);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].userText, 'hello');
    assert.equal(snapshot.entries[0].assistantText, 'hi');
    assert.equal(snapshot.pagination.available, true);
    assert.equal(snapshot.pagination.canLoadPrevious, true);
    assert.deepEqual(fixture.importUrls, [fixture.assetUrl]);
    assert.equal(fixture.scopeReads[0].selector, fixture.stateSelector);
    assert.equal(fixture.scopeReads[0].key, fixture.chatId);
    assert.equal(fixture.scopeReads[1].selector, fixture.paginationSelector);
    assert.equal(fixture.scopeReads[1].key, fixture.stateKey);
    assert.equal(fixture.values.loadCalls, 0);
    adapter.dispose();
}

test('discovers the current-style graph through source-linked exports', async () => {
    await assertReadableAdapter(makeFixture());
});

test('discovers legacy module IDs without depending on MrG or fixed export letters', async () => {
    await assertReadableAdapter(makeFixture({
        names: {
            ids: {state: 'MrG'},
            exports: {scope: 'token', state: 'selector', pagination: 'pageSelector', loader: 'previousPage', history: 'history'}
        },
        exportStyle: 'namespace'
    }));
});

test('discovers renamed graphs through minified comma declarators and loads a page with native bindings', async () => {
    const fixture = makeFixture({
        realShape: true,
        names: {
            ids: {
                scope: 'bundle-token-91', state: 'select-42', pagination: 'cache-pages-3',
                loader: 'fetch-previous-81', react: 'dom-sync-7',
                hooks: 'hook-runtime-55', history: 'conversation-view-99'
            },
            exports: {
                scope: '$scopeToken', state: 'state/selector', pagination: 'pages.selector',
                loader: 'go-back', react: 'sync.now', hookScope: 's',
                hookValue: 'v', history: 'native-view'
            },
            locals: {
                scopeToken: 't0', stateSelector: 's0', paginationSelector: 'p0',
                flushSync: 'f0', hookScope: 'h0', hookValue: 'h1',
                loaderFunction: 'l0', componentFunction: 'c0',
                scopeDep: 'd0', stateDep: 'd1', paginationDep: 'd2',
                loaderDep: 'd3', reactDep: 'd4', hooksDep: 'd5',
                scopeValue: 'scopeResult', keyValue: 'stateKeyResult',
                pageValue: 'pageResult', conversationValue: 'cidResult',
                callbackValue: 'callbackResult', factoryModuleArg: 'e', factoryExportsArg: 't', factoryRequireArg: 'n',
                loaderScopeArg: 'e', loaderCidArg: 't', loaderFlushArg: 'a'
            }
        },
        referenceStyle: 'bracket',
        callStyle: 'babel',
        exportStyle: 'namespace'
    });
    const adapter = await loadCore(fixture).createNativeAdapter(adapterOptions(fixture));
    const before = adapter.readSnapshot();
    assert.equal(before.entries.length, 1);
    assert.equal(before.pagination.canLoadPrevious, true);
    const after = await adapter.loadPreviousPage();
    assert.equal(fixture.values.loadCalls, 1);
    assert.equal(fixture.values.flushCalls, 1);
    assert.equal(fixture.values.lastRequest.endpoint, '/conversations/{conversation_id}/messages');
    assert.equal(fixture.values.lastRequest.request.queryKey[0], 'chatgpt-conversation-page');
    assert.equal(after.entries.length, 2);
    assert.equal(after.pagination.complete, true);
    assert.ok(fixture.scopeReads.some(read => read.selector === fixture.paginationSelector && read.key === fixture.stateKey));
    adapter.dispose();
});

test('ignores comment, string, and disconnected-loader decoys without requiring unrelated factories', async () => {
    const fixture = makeFixture({decoys: true});
    await assertReadableAdapter(fixture);
    assert.equal(fixture.values.unrelatedFactoryExecutions, 0);
});

test('reports a missing required selector export explicitly', async () => {
    const fixture = makeFixture({missingExport: 'state'});
    const core = loadCore(fixture);
    await assert.rejects(
        core.createNativeAdapter(adapterOptions(fixture)),
        error => error.code === 'NATIVE_MODULE_EXPORT_SHAPE_UNKNOWN'
    );
});

test('reports an invalid required selector export explicitly', async () => {
    const fixture = makeFixture({invalidStateSelector: true});
    const core = loadCore(fixture);
    await assert.rejects(
        core.createNativeAdapter(adapterOptions(fixture)),
        error => error.code === 'NATIVE_MODULE_EXPORT_SHAPE_UNKNOWN'
    );
});

test('allows a valid graph when pagination state has not been initialized', async () => {
    const fixture = makeFixture({pagination: null});
    const adapter = await loadCore(fixture).createNativeAdapter(adapterOptions(fixture));
    const snapshot = adapter.readSnapshot();
    assert.equal(snapshot.pagination.available, false);
    assert.equal(snapshot.pagination.complete, false);
    assert.equal(snapshot.pagination.canLoadPrevious, false);
    adapter.dispose();
});

test('treats a null cursor with older pages loaded as pagination exhaustion', async () => {
    const fixture = makeFixture({
        pagination: {
            complete: false, cursor: null, hasLoadedOlderPages: true,
            hasError: false, isLoading: false
        }
    });
    const adapter = await loadCore(fixture).createNativeAdapter(adapterOptions(fixture));
    const {pagination} = adapter.readSnapshot();
    assert.equal(pagination.available, true);
    assert.equal(pagination.complete, true);
    assert.equal(pagination.cursor, null);
    assert.equal(pagination.canLoadPrevious, false);
    adapter.dispose();
});

test('fails explicitly when two valid graphs are present without loading either', async () => {
    const fixture = makeFixture({
        alternateGraph: {
            ids: {loader: 'second-loader', history: 'second-history'},
            exports: {loader: 'loadOlder', history: 'NativeHistoryTwo'},
            locals: {loaderFunction: 'fetchAnotherPage', componentFunction: 'SecondHistoryComponent'}
        }
    });
    const core = loadCore(fixture);
    await assert.rejects(
        core.createNativeAdapter(adapterOptions(fixture)),
        error => error.code === 'NATIVE_MODULE_DISCOVERY_AMBIGUOUS'
    );
    assert.equal(fixture.values.loadCalls, 0);
});

test('reuses discovery without rescanning unchanged factories', async () => {
    const fixture = makeFixture();
    const core = loadCore(fixture);
    const first = await core.createNativeAdapter(adapterOptions(fixture));
    const scanned = fixture.scanCounter.count;
    assert.ok(scanned > 0, 'initial discovery should inspect factory source');
    const second = await core.createNativeAdapter(adapterOptions(fixture));
    assert.equal(fixture.scanCounter.count, scanned);
    assert.equal(second.readSnapshot().chatId, fixture.chatId);
    first.dispose();
    second.dispose();
});

test('invalidates discovery when the module table grows', async () => {
    const fixture = makeFixture();
    const core = loadCore(fixture);
    const first = await core.createNativeAdapter(adapterOptions(fixture));
    const scanned = fixture.scanCounter.count;
    fixture.addUnrelatedFactory();
    const second = await core.createNativeAdapter(adapterOptions(fixture));
    assert.ok(fixture.scanCounter.count > scanned);
    assert.equal(second.readSnapshot().chatId, fixture.chatId);
    first.dispose();
    second.dispose();
});

test('invalidates discovery when a selected factory is replaced at the same module count', async () => {
    const fixture = makeFixture();
    const core = loadCore(fixture);
    const first = await core.createNativeAdapter(adapterOptions(fixture));
    const scanned = fixture.scanCounter.count;
    fixture.replaceSelectedLoaderFactory();
    const second = await core.createNativeAdapter(adapterOptions(fixture));
    assert.ok(fixture.scanCounter.count > scanned);
    assert.equal(second.readSnapshot().chatId, fixture.chatId);
    first.dispose();
    second.dispose();
});

test('rejects an adapter when the requested conversation ID differs from the route', async () => {
    const fixture = makeFixture();
    const core = loadCore(fixture);
    await assert.rejects(
        core.createNativeAdapter(adapterOptions(fixture, 'another-chat')),
        error => error.code === 'STALE_NATIVE_ADAPTER'
    );
});
