const test = require('node:test');
const assert = require('node:assert/strict');
const {
    chooseCurrentReplyCandidate,
    chooseAdjacentReplyHeading,
    computeReplyScrollDelta,
    getRequiredScrollExtension,
    collectFixedPositionAncestors,
    computeBottomOverlayInset,
    clipReplyScrollViewportGeometry,
    computeReplyToolbarPosition,
    computeReplyOutlinePosition,
    computeReplyOutlineTooltipPosition,
    bindReplyOutlineToggle
} = require('./chatgpt-conversation-navigator.user.js');

const REPLY_OUTLINE_PINNED_STORAGE_KEY =
    'yw-chatgpt-conversation-navigator:reply-outline-pinned';

function makeReply(id, top, bottom, readingY, visibleTop = 0, visibleBottom = 800) {
    return {
        id,
        rect: {top, bottom, left: 300, right: 700, width: 400, height: bottom - top},
        readingY,
        visibleTop,
        visibleBottom,
        visibleLeft: 250,
        visibleRight: 1200
    };
}

function makeTestStorage(initialEntries = []) {
    const entries = new Map(initialEntries);
    return {
        getItem(key) { return entries.get(key) ?? null; },
        setItem(key, value) { entries.set(String(key), String(value)); },
        removeItem(key) { entries.delete(key); },
        clear() { entries.clear(); }
    };
}

test('current reply selection chooses the nearest visible assistant at a reading-point gap', () => {
    const selected = chooseCurrentReplyCandidate([
        makeReply('offscreen', -240, -90, 300),
        makeReply('previous', 100, 180, 300),
        makeReply('next', 340, 420, 300),
        makeReply('farther', 600, 650, 300)
    ]);

    assert.equal(selected.id, 'next');
    assert.equal(selected.pointInside, false);
});

test('heading navigation advances from the visible top edge and reverses to the prior heading', () => {
    const headings = [100, 300, 500].map(top => ({top}));

    const firstDown = chooseAdjacentReplyHeading(headings, 200, 'down', 2);
    assert.equal(firstDown.top, 300);

    const secondDown = chooseAdjacentReplyHeading(headings, firstDown.top, 'down', 2);
    assert.equal(secondDown.top, 500);

    const up = chooseAdjacentReplyHeading(headings, secondDown.top, 'up', 2);
    assert.equal(up.top, 300);
    assert.equal(chooseAdjacentReplyHeading(headings, 100, 'up', 2), null);
});

test('heading jumps beyond the current scroll limit extend range and still progress', () => {
    const headings = [{top: 80}, {top: 360}, {top: 520}];
    const edge = 200;
    const scrollTop = 210;
    const currentMax = 220;
    const next = chooseAdjacentReplyHeading(headings, edge, 'down', 2);
    const delta = computeReplyScrollDelta({
        targetTop: next.top,
        targetBottom: next.top + 24,
        viewportTop: edge,
        viewportBottom: 900
    });
    const desiredTop = scrollTop + delta;

    assert.equal(next.top, 360);
    assert.equal(desiredTop, 370);
    assert.equal(getRequiredScrollExtension(desiredTop, currentMax), 150);

    const shiftedHeadings = headings.map(heading => ({
        top: heading.top - delta
    }));
    assert.equal(shiftedHeadings[1].top, edge);
    assert.equal(
        chooseAdjacentReplyHeading(shiftedHeadings, edge, 'down', 2).top,
        360
    );
});

test('reply alignment uses the fixed header and bottom overlay edges', () => {
    const topDelta = computeReplyScrollDelta({
        targetTop: 250,
        targetBottom: 400,
        viewportTop: 50,
        viewportBottom: 850,
        topInset: 40,
        bottomInset: 100,
        edge: 'top'
    });
    const bottomDelta = computeReplyScrollDelta({
        targetTop: 700,
        targetBottom: 900,
        viewportTop: 50,
        viewportBottom: 850,
        topInset: 40,
        bottomInset: 100,
        edge: 'bottom'
    });

    assert.equal(topDelta, 160);
    assert.equal(bottomDelta, 150);
});

test('composer inputs discover fixed or sticky ancestors only up to the scroll container', () => {
    const body = {name: 'body', parentElement: null};
    const outside = {name: 'outside', parentElement: body};
    const scroller = {name: 'scroller', parentElement: outside};
    const sticky = {name: 'sticky', parentElement: scroller};
    const form = {name: 'form', parentElement: sticky};
    const input = {name: 'input', parentElement: form};
    const positions = new Map([
        [outside, 'fixed'],
        [scroller, 'static'],
        [sticky, 'sticky'],
        [form, 'static'],
        [input, 'static']
    ]);

    const overlays = collectFixedPositionAncestors(
        [input, form, input],
        scroller,
        body,
        element => positions.get(element) || 'static'
    );

    assert.deepEqual(overlays, [sticky]);
});

test('composer discovery keeps nested absolute wrappers but excludes the app shell containing the scroller', () => {
    const body = {name: 'body', parentElement: null};
    const shell = {name: 'shell', parentElement: body};
    const scroller = {name: 'scroller', parentElement: shell};
    const floatingComposer = {name: 'floatingComposer', parentElement: shell};
    const wrapper = {name: 'wrapper', parentElement: floatingComposer};
    const form = {name: 'form', parentElement: wrapper};
    const input = {name: 'input', parentElement: form};
    const positions = new Map([
        [shell, 'fixed'],
        [floatingComposer, 'absolute'],
        [wrapper, 'static'],
        [form, 'static'],
        [input, 'static']
    ]);
    const contains = (element, descendant) => {
        for (let node = descendant; node; node = node.parentElement) {
            if (node === element) return true;
        }
        return false;
    };

    const overlays = collectFixedPositionAncestors(
        [input],
        scroller,
        body,
        element => positions.get(element) || 'static',
        element => contains(element, scroller),
        ['fixed', 'sticky', 'absolute']
    );

    assert.deepEqual(overlays, [floatingComposer]);
});

test('bottom overlay inset requires viewport-bottom and horizontal overlap', () => {
    const inset = computeBottomOverlayInset([
        {
            position: 'sticky',
            rect: {left: 300, right: 900, top: 760, bottom: 850}
        },
        {
            position: 'fixed',
            rect: {left: 901, right: 1200, top: 700, bottom: 850}
        },
        {
            position: 'sticky',
            rect: {left: 300, right: 900, top: 50, bottom: 70}
        }
    ], {top: 50, bottom: 850}, 500);

    assert.equal(inset, 98);
});

test('floating composer reserves its top plus a reading gap without treating a generic block as an overlay', () => {
    const viewport = {left: 343, right: 1739, top: 50, bottom: 1244};
    const targetRect = {left: 400, right: 1000};
    const composer = {
        kind: 'composer',
        position: 'absolute',
        rect: {left: 420, right: 980, top: 1000, bottom: 1228}
    };
    const genericBlock = {...composer, kind: 'edge'};

    assert.equal(
        computeBottomOverlayInset([composer], viewport, 700, targetRect),
        258
    );
    assert.equal(
        computeBottomOverlayInset([genericBlock], viewport, 700, targetRect),
        0
    );
});

test('bottom alignment extends a nested scroller enough to clear a floating composer', () => {
    const bottomInset = computeBottomOverlayInset([{
        kind: 'composer',
        position: 'fixed',
        rect: {left: 400, right: 1000, top: 1000, bottom: 1228}
    }], {left: 343, right: 1739, top: 0, bottom: 1244}, 700, {
        left: 400,
        right: 1000
    });
    const delta = computeReplyScrollDelta({
        targetTop: 1100,
        targetBottom: 1200,
        viewportTop: 0,
        viewportBottom: 1244,
        bottomInset,
        edge: 'bottom'
    });
    const currentTop = 190;
    const desiredTop = currentTop + delta;

    assert.equal(bottomInset, 258);
    assert.equal(delta, 214);
    assert.equal(getRequiredScrollExtension(desiredTop, 200), 204);
    assert.equal(1200 - delta, 986);
});

test('scroll viewport geometry clips a nested scroller to the visible window', () => {
    assert.deepEqual(clipReplyScrollViewportGeometry({
        left: -20,
        right: 900,
        top: 800,
        bottom: 1400
    }, 1739, 1244), {
        left: 0,
        right: 900,
        top: 800,
        bottom: 1244,
        height: 444
    });
});

test('left toolbar follows the sidebar edge and stays centered in the window', () => {
    const base = {
        windowWidth: 1400,
        windowHeight: 900,
        contentLeft: 420,
        sidebarVisible: true,
        sidebarLeft: 0,
        toolbarHeight: 202
    };
    assert.deepEqual(computeReplyToolbarPosition({
        ...base,
        sidebarRight: 280
    }), {left: 292, top: 349});
    assert.deepEqual(computeReplyToolbarPosition({
        ...base,
        sidebarRight: 72,
        contentLeft: 220
    }), {left: 84, top: 349});
    assert.deepEqual(computeReplyToolbarPosition({
        ...base,
        sidebarVisible: false,
        sidebarLeft: null,
        sidebarRight: null,
        contentLeft: 120
    }), {left: 12, top: 349});
    assert.equal(computeReplyToolbarPosition({
        ...base,
        sidebarRight: 72,
        contentLeft: 110
    }), null, 'toolbar hides when it would consume the 48px content gutter');
});

test('outline panel opens just after the sidebar or trigger and shrinks to available width', () => {
    assert.deepEqual(computeReplyOutlinePosition({
        windowWidth: 1200,
        windowHeight: 800,
        sidebarRight: 260,
        sidebarVisible: true,
        toolbarLeft: 12,
        headerBottom: 64
    }), {
        left: 268,
        top: 72,
        width: 300,
        maxHeight: 560,
        visible: true
    });
    assert.deepEqual(computeReplyOutlinePosition({
        windowWidth: 300,
        windowHeight: 180,
        sidebarRight: 64,
        sidebarVisible: true,
        toolbarLeft: 12,
        headerBottom: 130
    }), {
        left: 72,
        top: 138,
        width: 220,
        maxHeight: 34,
        visible: true
    });
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 600,
        windowHeight: 800,
        sidebarRight: 260,
        sidebarVisible: true,
        headerBottom: 64
    }).width, 300, 'panel uses its preferred width when it fits');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 480,
        windowHeight: 800,
        sidebarRight: 260,
        sidebarVisible: true,
        headerBottom: 64
    }).width, 204, 'panel shrinks to the space after the sidebar');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 1200,
        windowHeight: 800,
        toolbarLeft: 24,
        headerBottom: 64
    }).left, 24, 'collapsed sidebar uses the trigger left edge');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 1200,
        windowHeight: 800,
        headerBottom: 64
    }).left, 8, 'missing trigger geometry falls back to the viewport inset');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 600,
        windowHeight: 500,
        sidebarRight: 200,
        sidebarVisible: true,
        headerBottom: 497
    }).visible, false);
});

test('outline display normalizes only the first entry and preserves native levels', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const context = {
        chatIdentity: 'chat-1',
        identity: 'reply-1',
        reply: {isConnected: true}
    };
    const entries = [
        {element: makeTestElement(), level: 4, text: 'First native H4'},
        {element: makeTestElement(), level: 2, text: 'Later native H2'},
        {element: makeTestElement(), level: 6, text: 'Later native H6'}
    ];
    runtime.install({ui});
    runtime.renderOutline(context, entries);

    assert.deepEqual(ui.list.children.map(item =>
        item.children[0].style.paddingInlineStart
    ), ['6px', '14px', '46px']);
    assert.deepEqual(entries.map(entry => entry.level), [4, 2, 6]);
});

test('outline tooltip stays static while the accessible toggle label follows open state', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const headerToolbar = makeTestParent();
    headerToolbar.insertBefore(makeTestElement(), null);
    const context = {reply: {isConnected: true}};
    runtime.install({ui, headerToolbar, currentReplyContext: context});

    runtime.renderOutline(context, []);
    assert.equal(ui.outlineToggle.getAttribute('aria-label'), '展开大纲');
    runtime.showTooltip();
    assert.equal(ui.outlineTooltip.textContent, '展开大纲');
    assert.equal(ui.outlineTooltip.hidden, false);

    runtime.setReplyOutlineOpen(true);
    assert.equal(ui.outlineToggle.getAttribute('aria-label'), '收起大纲');
    assert.equal(ui.outlineTooltip.hidden, true);
    assert.equal(ui.outlineTooltip.textContent, '展开大纲');
    runtime.showTooltip();
    assert.equal(ui.outlineTooltip.hidden, true);
    runtime.renderOutline(context, []);
    assert.equal(ui.outlineToggle.getAttribute('aria-label'), '收起大纲');

    runtime.setReplyOutlineOpen(false);
    assert.equal(ui.outlineToggle.getAttribute('aria-label'), '展开大纲');
    assert.equal(ui.outlineTooltip.textContent, '展开大纲');
});

test('outline pin preference restores only the exact saved true value for new runtimes', () => {
    const storage = makeTestStorage([
        [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'true']
    ]);
    const restoredRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const restoredUI = makeNavigationTestUI();
    restoredRuntime.install({ui: restoredUI});

    assert.equal(restoredRuntime.state().pinned, true);
    assert.equal(restoredUI.outlinePinButton.getAttribute('aria-pressed'), 'true');
    assert.equal(restoredRuntime.storageListenerCount(), 0);

    storage.setItem(REPLY_OUTLINE_PINNED_STORAGE_KEY, 'false');
    const restoredOffRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const restoredOffUI = makeNavigationTestUI();
    restoredOffRuntime.install({ui: restoredOffUI});
    assert.equal(restoredOffRuntime.state().pinned, false);
    assert.equal(restoredOffUI.outlinePinButton.getAttribute('aria-pressed'), 'false');

    storage.setItem(REPLY_OUTLINE_PINNED_STORAGE_KEY, 'True');
    const invalidValueRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const invalidValueUI = makeNavigationTestUI();
    invalidValueRuntime.install({ui: invalidValueUI});
    assert.equal(invalidValueRuntime.state().pinned, false);
});

test('pin preference persists for new runtimes while open tabs ignore storage events', () => {
    const storage = makeTestStorage();
    const firstRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const secondRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const firstUI = makeNavigationTestUI();
    const secondUI = makeNavigationTestUI();
    const context = {reply: {isConnected: true}};
    firstRuntime.install({ui: firstUI, outlineOpen: true, currentReplyContext: context});
    secondRuntime.install({ui: secondUI, outlineOpen: true, currentReplyContext: context});

    firstRuntime.click(firstUI.outlinePinButton);
    assert.equal(storage.getItem(REPLY_OUTLINE_PINNED_STORAGE_KEY), 'true');
    secondRuntime.dispatchStorage({
        key: REPLY_OUTLINE_PINNED_STORAGE_KEY,
        oldValue: null,
        newValue: 'true',
        storageArea: storage
    });
    assert.equal(firstRuntime.storageListenerCount(), 0);
    assert.equal(secondRuntime.state().pinned, false);
    assert.equal(secondUI.outlinePinButton.getAttribute('aria-pressed'), 'false');
    assert.equal(secondRuntime.state().open, true);

    secondRuntime.click(makeTestElement());
    assert.equal(secondRuntime.state().open, false);
    firstRuntime.dispatchStorage({
        key: REPLY_OUTLINE_PINNED_STORAGE_KEY,
        oldValue: null,
        newValue: 'true',
        storageArea: storage
    });
    assert.equal(firstRuntime.state().pinned, true);
    assert.equal(firstRuntime.state().open, true);

    const restoredPinnedRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const restoredPinnedUI = makeNavigationTestUI();
    restoredPinnedRuntime.install({ui: restoredPinnedUI});
    assert.equal(restoredPinnedRuntime.state().pinned, true);

    restoredPinnedRuntime.click(restoredPinnedUI.outlinePinButton);
    assert.equal(storage.getItem(REPLY_OUTLINE_PINNED_STORAGE_KEY), 'false');
    firstRuntime.dispatchStorage({
        key: REPLY_OUTLINE_PINNED_STORAGE_KEY,
        oldValue: 'true',
        newValue: 'false',
        storageArea: storage
    });
    assert.equal(firstRuntime.state().pinned, true);
    assert.equal(firstRuntime.state().open, true);

    const restoredUnpinnedRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const restoredUnpinnedUI = makeNavigationTestUI();
    restoredUnpinnedRuntime.install({ui: restoredUnpinnedUI});
    assert.equal(restoredUnpinnedRuntime.state().pinned, false);
});

test('pin remains usable when localStorage is unavailable or throws', () => {
    for (const localStorage of [
        undefined,
        () => { throw new Error('blocked localStorage'); }
    ]) {
        const runtime = loadReplyNavigationRuntime({localStorage});
        const ui = makeNavigationTestUI();
        runtime.install({ui, outlineOpen: true});

        assert.equal(ui.outlinePinButton.getAttribute('aria-pressed'), 'false');
        runtime.click(ui.outlinePinButton);
        assert.equal(runtime.state().pinned, true);
        assert.equal(ui.outlinePinButton.getAttribute('aria-pressed'), 'true');
        assert.equal(runtime.state().open, true);
    }
});

test('outline pin starts off and toggles its icon and accessibility state without closing', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const context = {reply: {isConnected: true}};
    runtime.install({ui, outlineOpen: true, currentReplyContext: context});

    assert.equal(ui.outlinePinButton.getAttribute('aria-pressed'), 'false');
    assert.equal(ui.outlinePinButton.getAttribute('aria-label'), '固定大纲');
    assert.equal(ui.outlinePinButton.getAttribute('title'), '固定大纲');
    assert.deepEqual(ui.outlinePinButton.children[0].children.map(path =>
        path.getAttribute('d')
    ), [
        'M12 17v5',
        'M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89',
        'm2 2 20 20',
        'M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11'
    ]);

    const pinEvent = runtime.click(ui.outlinePinButton);
    assert.equal(pinEvent.defaultPrevented, true);
    assert.equal(pinEvent.propagationStopped, true);
    assert.equal(runtime.state().open, true);
    assert.equal(ui.outlinePinButton.getAttribute('aria-pressed'), 'true');
    assert.equal(ui.outlinePinButton.getAttribute('aria-label'), '取消固定大纲');
    assert.equal(ui.outlinePinButton.getAttribute('title'), '取消固定大纲');
    assert.deepEqual(ui.outlinePinButton.children[0].children.map(path =>
        path.getAttribute('d')
    ), [
        'M12 17v5',
        'M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z'
    ]);

    runtime.click(ui.outlinePinButton);
    assert.equal(ui.outlinePinButton.getAttribute('aria-pressed'), 'false');
    assert.equal(ui.outlinePinButton.getAttribute('aria-label'), '固定大纲');
    assert.equal(runtime.state().open, true);
});

test('outside clicks collapse an unpinned outline and preserve a pinned one', () => {
    const unpinnedRuntime = loadReplyNavigationRuntime();
    const unpinnedUI = makeNavigationTestUI();
    unpinnedRuntime.install({
        ui: unpinnedUI,
        outlineOpen: true,
        currentReplyContext: {reply: {isConnected: true}}
    });

    unpinnedRuntime.click(makeTestElement());
    assert.equal(unpinnedRuntime.state().open, false);
    assert.equal(unpinnedUI.outline.hidden, true);

    const pinnedRuntime = loadReplyNavigationRuntime();
    const pinnedUI = makeNavigationTestUI();
    pinnedRuntime.install({
        ui: pinnedUI,
        outlineOpen: true,
        currentReplyContext: {reply: {isConnected: true}}
    });
    pinnedRuntime.click(pinnedUI.outlinePinButton);
    pinnedRuntime.click(makeTestElement());
    assert.equal(pinnedRuntime.state().open, true);
    assert.equal(pinnedUI.outline.hidden, false);
});

test('inside clicks keep the outline open and the toggle still opens and closes it', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const headerToolbar = makeTestParent();
    headerToolbar.insertBefore(makeTestElement(), null);
    const reply = makeTestElement();
    reply.querySelectorAll = () => [];
    reply.matches = () => false;
    const context = {
        identity: 'reply-1',
        chatIdentity: 'chat-1',
        reply,
        visibleTop: 200,
        readingY: 300,
        rect: {top: 300, bottom: 700, left: 300, width: 500},
        viewport: {top: 0}
    };
    runtime.install({ui, headerToolbar, currentReplyContext: context});

    runtime.click(ui.outlineToggle);
    assert.equal(runtime.state().open, true);
    assert.equal(ui.outlineToggle.getAttribute('aria-expanded'), 'true');

    const inside = makeTestElement();
    ui.outlineHeadingRow.appendChild(inside);
    runtime.click(inside);
    assert.equal(runtime.state().open, true);

    runtime.click(ui.outlineToggle);
    assert.equal(runtime.state().open, false);
    assert.equal(ui.outlineToggle.getAttribute('aria-expanded'), 'false');
});

test('body-level outline tooltip aligns left and clamps at viewport edges', () => {
    assert.deepEqual(computeReplyOutlineTooltipPosition({
        windowWidth: 1000,
        windowHeight: 600,
        anchorLeft: 900,
        anchorRight: 980,
        anchorBottom: 50,
        tooltipWidth: 130,
        tooltipHeight: 28
    }), {left: 862, top: 58, width: 130, height: 28});
    assert.deepEqual(computeReplyOutlineTooltipPosition({
        windowWidth: 320,
        windowHeight: 180,
        anchorLeft: 0,
        anchorRight: 64,
        anchorBottom: 170,
        tooltipWidth: 360,
        tooltipHeight: 40
    }), {left: 8, top: 132, width: 304, height: 40});
});

test('outline tooltip is anchored to its toggle and hides when focus leaves', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    ui.outlineToggle.rect = {
        left: 1100, right: 1190, top: 12, bottom: 50, width: 90, height: 38
    };
    ui.outlineTooltip.rect = {
        left: 0, right: 130, top: 0, bottom: 28, width: 130, height: 28
    };
    runtime.install({ui, currentReplyContext: {reply: {isConnected: true}}});

    runtime.showTooltip();
    assert.equal(ui.outlineTooltip.hidden, false);
    assert.equal(ui.outlineTooltip.dataset.visible, 'true');
    assert.equal(ui.outlineTooltip.style.left, '1062px');
    assert.equal(ui.outlineTooltip.style.top, '58px');

    runtime.hideTooltip();
    assert.equal(ui.outlineTooltip.hidden, true);
    assert.equal(ui.outlineTooltip.dataset.visible, 'false');
    assert.equal(ui.outlineTooltip.style.left, undefined);
    assert.equal(ui.outlineTooltip.style.top, undefined);
});

test('outline tooltip follows hover and keyboard focus without latching mouse focus', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    ui.outlineToggle.rect = {
        left: 1100, right: 1190, top: 12, bottom: 50, width: 90, height: 38
    };
    ui.outlineTooltip.rect = {
        left: 0, right: 130, top: 0, bottom: 28, width: 130, height: 28
    };
    let hovered = false;
    let keyboardFocused = false;
    ui.outlineToggle.matches = selector =>
        selector === ':hover' ? hovered :
            selector === ':focus-visible' && keyboardFocused;
    runtime.install({ui, currentReplyContext: {reply: {isConnected: true}}});

    const dispatch = type => ui.outlineToggle.dispatchEvent({
        type,
        target: ui.outlineToggle
    });

    dispatch('focus');
    assert.equal(ui.outlineTooltip.hidden, true);

    hovered = true;
    dispatch('pointerenter');
    assert.equal(ui.outlineTooltip.hidden, false);
    dispatch('focus');
    hovered = false;
    dispatch('pointerleave');
    assert.equal(ui.outlineTooltip.hidden, true);

    keyboardFocused = true;
    dispatch('focus');
    assert.equal(ui.outlineTooltip.hidden, false);
    dispatch('pointerleave');
    assert.equal(ui.outlineTooltip.hidden, false);

    keyboardFocused = false;
    dispatch('blur');
    assert.equal(ui.outlineTooltip.hidden, true);
});

test('outline tooltip is limited to the collapsed state for hover, focus and direct updates', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const headerToolbar = makeTestParent();
    headerToolbar.insertBefore(makeTestElement(), null);
    const reply = makeTestElement();
    reply.querySelectorAll = () => [];
    reply.matches = () => false;
    const context = {
        identity: 'reply-1',
        chatIdentity: 'chat-1',
        reply,
        rect: {left: 300, right: 800, top: 300, bottom: 700, width: 500, height: 400},
        visibleTop: 200,
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    };
    let hovered = false;
    let keyboardFocused = false;
    ui.outlineToggle.matches = selector =>
        selector === ':hover' ? hovered :
            selector === ':focus-visible' && keyboardFocused;
    runtime.install({ui, headerToolbar, currentReplyContext: context});

    const dispatch = type => ui.outlineToggle.dispatchEvent({
        type,
        target: ui.outlineToggle
    });

    hovered = true;
    dispatch('pointerenter');
    assert.equal(ui.outlineTooltip.hidden, false);
    assert.equal(ui.outlineTooltip.textContent, '展开大纲');

    runtime.click(ui.outlineToggle);
    assert.equal(runtime.state().open, true);
    assert.equal(ui.outlineToggle.getAttribute('aria-label'), '收起大纲');
    assert.equal(ui.outlineTooltip.hidden, true);

    hovered = false;
    dispatch('pointerleave');
    hovered = true;
    dispatch('pointerenter');
    assert.equal(ui.outlineTooltip.hidden, true);

    keyboardFocused = true;
    dispatch('focus');
    assert.equal(ui.outlineTooltip.hidden, true);
    runtime.showTooltip();
    runtime.updateReplyTopButton();
    assert.equal(ui.outlineTooltip.hidden, true);

    keyboardFocused = false;
    dispatch('blur');
    assert.equal(ui.outlineTooltip.hidden, true);
    runtime.click(ui.outlineToggle);
    assert.equal(runtime.state().open, false);
    assert.equal(ui.outlineToggle.getAttribute('aria-label'), '展开大纲');
    assert.equal(ui.outlineTooltip.hidden, false);
    assert.equal(ui.outlineTooltip.textContent, '展开大纲');

    hovered = true;
    dispatch('pointerenter');
    assert.equal(ui.outlineTooltip.hidden, false);
    assert.equal(ui.outlineTooltip.textContent, '展开大纲');

    runtime.updateReplyTopButton();
    assert.equal(ui.outlineTooltip.hidden, false);
    assert.equal(ui.outlineTooltip.textContent, '展开大纲');
});

test('visible outline tooltip reanchors on the normal reply-layout update', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const headerToolbar = makeTestParent();
    headerToolbar.insertBefore(ui.outlineToggle, null);
    ui.outlineToggle.rect = {
        left: 1100, right: 1190, top: 12, bottom: 50, width: 90, height: 38
    };
    ui.outlineTooltip.rect = {
        left: 0, right: 130, top: 0, bottom: 28, width: 130, height: 28
    };
    const reply = {
        isConnected: true,
        querySelectorAll: () => [],
        contains: () => false
    };
    const context = {
        identity: 'reply-1',
        chatIdentity: 'chat-1',
        reply,
        rect: {left: 500, right: 900, top: 200, bottom: 320, width: 400, height: 120},
        visibleTop: 50,
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    };
    runtime.install({ui, headerToolbar, currentReplyContext: context});

    runtime.showTooltip();
    ui.outlineToggle.rect = {
        left: 800, right: 880, top: 100, bottom: 138, width: 80, height: 38
    };
    runtime.updateReplyTopButton();
    assert.equal(ui.outlineTooltip.hidden, false);
    assert.equal(ui.outlineTooltip.style.left, '800px');
    assert.equal(ui.outlineTooltip.style.top, '146px');
});

test('project header row binding inserts first and survives header replacement', () => {
    const runtime = loadReplyNavigationRuntime();
    const makeProjectHeader = () => {
        const modelButton = makeTestElement();
        modelButton.tagName = 'BUTTON';
        const shareButton = makeTestElement();
        shareButton.tagName = 'BUTTON';
        shareButton.setAttribute('data-testid', 'share-button');
        const toolbar = makeTestParent();
        toolbar.tagName = 'DIV';
        toolbar.className = 'Toolbar-w4tLPD flex';
        toolbar.querySelector = () => modelButton;
        toolbar.querySelectorAll = selector =>
            selector === 'button, [role="button"]'
                ? [modelButton, shareButton]
                : [];
        toolbar.rect = {left: 300, right: 900, top: 8, bottom: 48, width: 600, height: 40};
        toolbar.style = {display: 'flex'};
        toolbar.children.push(modelButton, shareButton);
        modelButton.parentElement = toolbar;
        shareButton.parentElement = toolbar;
        const moreButton = makeTestElement();
        moreButton.tagName = 'BUTTON';
        moreButton.className = 'Button-QTscM8 Toolbar-TcAqyt no-drag';
        const titlebar = makeTestParent();
        titlebar.tagName = 'DIV';
        titlebar.className = 'group/titlebar flex';
        titlebar.setAttribute('data-app-shell-main-titlebar', 'true');
        titlebar.style.display = 'flex';
        titlebar.rect = {left: 249, right: 1230, top: 0, bottom: 52, width: 981, height: 52};
        titlebar.appendChild(toolbar);
        titlebar.appendChild(moreButton);
        configureOutlineSearch(titlebar, {
            named: [toolbar, moreButton],
            buttons: [modelButton, shareButton, moreButton]
        });
        const header = makeTestElement({
            rect: {left: 0, right: 1230, top: 0, bottom: 52, width: 1230, height: 52}
        });
        header.tagName = 'HEADER';
        header.querySelector = selector =>
            selector === '[data-app-shell-main-titlebar="true"]'
                ? titlebar
                : null;
        header.appendChild(titlebar);
        configureOutlineSearch(header, {
            named: [toolbar, moreButton],
            buttons: [modelButton, shareButton, moreButton]
        });
        return {header, titlebar, toolbar};
    };
    const first = makeProjectHeader();
    runtime.setHeader(first.header);
    const toggle = makeTestElement();
    assert.equal(runtime.findHeaderToolbar(), first.toolbar);
    assert.equal(bindReplyOutlineToggle(toggle, first.toolbar, true), true);
    assert.equal(first.toolbar.firstElementChild, toggle);

    const replacement = makeProjectHeader();
    runtime.setHeader(replacement.header);
    assert.equal(runtime.findHeaderToolbar(), replacement.toolbar);
    assert.equal(bindReplyOutlineToggle(toggle, replacement.toolbar, true), true);
    assert.equal(replacement.toolbar.firstElementChild, toggle);
    assert.equal(first.toolbar.children.includes(toggle), false);
});

test('normal chat binds to the semantic main titlebar independently of native button styling', () => {
    const runtime = loadReplyNavigationRuntime();
    const hiddenHeader = makeTestElement({
        hidden: true,
        rect: {left: 0, right: 1230, top: 0, bottom: 52, width: 1230, height: 52}
    });
    hiddenHeader.tagName = 'HEADER';
    const hiddenTitlebar = makeTestParent();
    hiddenTitlebar.tagName = 'DIV';
    hiddenTitlebar.setAttribute('data-app-shell-main-titlebar', 'true');
    hiddenTitlebar.style.display = 'flex';
    hiddenTitlebar.rect = {left: 249, right: 1230, top: 0, bottom: 52, width: 981, height: 52};
    hiddenHeader.querySelector = selector =>
        selector === '[data-app-shell-main-titlebar="true"]'
            ? hiddenTitlebar
            : null;
    hiddenHeader.appendChild(hiddenTitlebar);
    configureOutlineSearch(hiddenHeader);
    const titlebar = makeTestParent();
    titlebar.tagName = 'DIV';
    titlebar.className = 'group/titlebar pointer-events-none flex';
    titlebar.setAttribute('data-app-shell-main-titlebar', 'true');
    titlebar.style.display = 'flex';
    titlebar.rect = {left: 249, right: 1230, top: 0, bottom: 52, width: 981, height: 52};
    const actionGroup = makeTestParent();
    actionGroup.tagName = 'DIV';
    actionGroup.className = 'ms-auto flex shrink-0 items-center';
    actionGroup.style.display = 'flex';
    actionGroup.rect = {left: 1020, right: 1220, top: 4, bottom: 48, width: 200, height: 44};
    const shareButton = makeTestElement();
    shareButton.tagName = 'BUTTON';
    shareButton.setAttribute('aria-label', 'Share');
    const moreButton = makeTestElement();
    moreButton.tagName = 'BUTTON';
    moreButton.className = 'Button-QTscM8 Toolbar-TcAqyt no-drag outline-hidden cursor-interaction';
    moreButton.setAttribute('aria-label', '更多');
    for (const [name, value] of [
        ['data-color', 'primary'],
        ['data-variant', 'ghost'],
        ['data-state', 'closed'],
        ['aria-expanded', 'false'],
        ['aria-haspopup', 'menu']
    ]) {
        moreButton.setAttribute(name, value);
    }
    moreButton.id = 'native-more-button';
    actionGroup.appendChild(shareButton);
    actionGroup.appendChild(moreButton);
    titlebar.appendChild(actionGroup);
    configureOutlineSearch(titlebar, {
        named: [moreButton],
        flex: [actionGroup],
        buttons: [shareButton, moreButton]
    });
    const header = makeTestElement({
        rect: {left: 0, right: 1230, top: 0, bottom: 52, width: 1230, height: 52}
    });
    header.tagName = 'HEADER';
    header.querySelector = selector =>
        selector === '[data-app-shell-main-titlebar="true"]'
            ? titlebar
            : null;
    header.appendChild(titlebar);
    configureOutlineSearch(header, {
        named: [moreButton],
        flex: [titlebar, actionGroup],
        buttons: [shareButton, moreButton]
    });
    runtime.setHeaders([hiddenHeader, header]);

    assert.equal(runtime.findHeaderToolbar(), titlebar);
    const ui = makeNavigationTestUI();
    ui.outlineToggle.className = 'yw-reply-outline-toggle';
    ui.outlineToggle.id = 'outline-toggle-owned-id';
    ui.outlineToggle.setAttribute('aria-label', '展开大纲');
    ui.outlineToggle.setAttribute('aria-expanded', 'false');
    runtime.install({
        ui,
        currentReplyContext: {reply: {isConnected: true}}
    });
    runtime.syncToggleBinding(true);

    assert.equal(ui.outlineToggle.className, 'yw-reply-outline-toggle');
    assert.equal(ui.outlineToggle.getAttribute('data-color'), null);
    assert.equal(ui.outlineToggle.getAttribute('data-variant'), null);
    assert.equal(ui.outlineToggle.getAttribute('data-state'), null);
    assert.equal(ui.outlineToggle.getAttribute('aria-haspopup'), null);
    assert.equal(ui.outlineToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(ui.outlineToggle.id, 'outline-toggle-owned-id');
    assert.equal(titlebar.firstElementChild, ui.outlineToggle);
    assert.equal(actionGroup.firstElementChild, shareButton);
    assert.equal(moreButton.parentElement, actionGroup);
    assert.equal(moreButton.className, 'Button-QTscM8 Toolbar-TcAqyt no-drag outline-hidden cursor-interaction');
    assert.equal(moreButton.getAttribute('data-state'), 'closed');
    assert.equal(moreButton.getAttribute('aria-expanded'), 'false');
    assert.equal(moreButton.getAttribute('aria-haspopup'), 'menu');
    assert.equal(ui.outlineToggle.hidden, false);
});

test('invalid named toolbar matches leave the legacy flex fallback available', () => {
    const runtime = loadReplyNavigationRuntime();
    const header = makeTestElement({
        rect: {left: 0, right: 1230, top: 0, bottom: 52, width: 1230, height: 52}
    });
    header.tagName = 'HEADER';
    const moreButton = makeTestElement();
    moreButton.tagName = 'BUTTON';
    moreButton.className = 'Button-QTscM8 Toolbar-TcAqyt no-drag';
    const hiddenToolbar = makeTestParent();
    hiddenToolbar.tagName = 'DIV';
    hiddenToolbar.className = 'Toolbar-hidden flex';
    hiddenToolbar.style.display = 'none';
    const fallback = makeTestParent();
    fallback.tagName = 'DIV';
    fallback.className = 'flex';
    fallback.style.display = 'flex';
    fallback.rect = {left: 300, right: 900, top: 8, bottom: 48, width: 600, height: 40};
    header.appendChild(hiddenToolbar);
    header.appendChild(fallback);
    configureOutlineSearch(header, {
        named: [moreButton, hiddenToolbar],
        flex: [fallback],
        buttons: [moreButton]
    });
    runtime.setHeader(header);

    assert.equal(runtime.findHeaderToolbar(), fallback);
});

test('runtime keeps an open outline through a reply gap until the explicit toggle closes it', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const headerToolbar = makeTestParent();
    const toggle = makeTestElement();
    headerToolbar.insertBefore(toggle, null);
    const context = {
        identity: 'reply-1',
        reply: {isConnected: true},
        visibleTop: 200
    };
    runtime.install({ui, headerToolbar, outlineOpen: true, currentReplyContext: null});

    runtime.updateReplyTopButton();
    let state = runtime.state();
    assert.equal(state.open, true);
    assert.equal(state.rootHidden, false);
    assert.equal(state.toolbarHidden, true);
    assert.equal(state.outlineHidden, false);
    assert.equal(state.toggleHidden, false);
    assert.equal(state.expanded, 'true');
    assert.equal(ui.list.children[0].textContent, '正在定位当前回复…');

    runtime.toggleReplyOutline();
    state = runtime.state();
    assert.equal(state.open, false);
    assert.equal(state.rootHidden, true);
    assert.equal(state.outlineHidden, true);
    assert.equal(state.toggleHidden, true);
    assert.equal(state.expanded, 'false');
});

test('runtime positions the six-control toolbar from the sidebar edge at window center', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const headerToolbar = makeTestParent();
    headerToolbar.insertBefore(makeTestElement(), null);
    const context = {
        identity: 'reply-1',
        reply: {isConnected: true},
        visibleTop: 200,
        rect: {left: 420},
        chatIdentity: 'chat-1'
    };
    runtime.install({
        ui,
        headerToolbar,
        outlineOpen: false,
        currentReplyContext: context,
        sidebarGeometry: {left: 0, right: 280}
    });

    runtime.updateReplyNavigationControls(context, []);
    assert.equal(ui.toolbar.hidden, false);
    assert.equal(ui.toolbar.style.left, '292px');
    assert.equal(ui.toolbar.style.top, '299px');
});

test('assistant reply navigation skips unanswered entries and advances pending virtual targets', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const context = {identity: 'answered-1'};
    const turns = [
        {identity: 'unanswered', kind: 'user', assistantText: '', assistantMessageIds: []},
        {identity: 'answered-1', kind: 'user', assistantText: 'first answer', assistantMessageIds: ['a1']},
        {identity: 'independent-assistant', kind: 'assistant', messageId: 'a2'},
        {identity: 'answered-2', kind: 'user', assistantText: '', assistantMessageIds: ['a3']}
    ];
    const calls = [];
    runtime.install({ui, turns, currentReplyContext: context});
    runtime.setJumpToIdentity((...args) => calls.push(args));

    runtime.updateAssistantReplyNavigationButtons(context);
    assert.equal(ui.buttons.get('previous-reply').disabled, true);
    assert.equal(ui.replyButtons.get('previous').disabled, true);
    assert.equal(ui.buttons.get('next-reply').disabled, false);
    assert.equal(ui.replyButtons.get('next').disabled, false);
    runtime.navigateAssistantReply('next');
    runtime.navigateAssistantReply('next');
    assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
        ['independent-assistant', '', {replyTop: true}],
        ['answered-2', '', {replyTop: true}]
    ]);

    // A direct rail jump supersedes the pending adjacent search. Subsequent
    // navigation must use the actually selected reply instead of a stale cursor.
    runtime.setCurrentReplyContext(context);
    runtime.directJump('answered-1');
    runtime.updateAssistantReplyNavigationButtons(context);
    assert.equal(ui.buttons.get('previous-reply').disabled, true);
    assert.equal(ui.replyButtons.get('previous').disabled, true);
    assert.equal(ui.buttons.get('next-reply').disabled, false);
    assert.equal(ui.replyButtons.get('next').disabled, false);
    runtime.navigateAssistantReply('next');
    assert.equal(calls.at(-1)[0], 'independent-assistant');

    runtime.finishActiveJump();
    const independentContext = {identity: 'independent-assistant'};
    runtime.setCurrentReplyContext(independentContext);
    runtime.updateAssistantReplyNavigationButtons(independentContext);
    runtime.navigateAssistantReply('next');
    assert.equal(calls.at(-1)[0], 'answered-2');

    const lastContext = {identity: 'answered-2'};
    runtime.setCurrentReplyContext(lastContext);
    runtime.finishActiveJump();
    runtime.updateAssistantReplyNavigationButtons(lastContext);
    assert.equal(ui.buttons.get('next-reply').disabled, true);
    assert.equal(ui.replyButtons.get('next').disabled, true);
    assert.equal(ui.buttons.get('previous-reply').disabled, false);
    assert.equal(ui.replyButtons.get('previous').disabled, false);
    const callCountAtBoundary = calls.length;
    runtime.navigateAssistantReply('next');
    assert.equal(calls.length, callCountAtBoundary);
});

function loadReplyNavigationRuntime({localStorage} = {}) {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const filename = require.resolve('./chatgpt-conversation-navigator.user.js');
    const source = fs.readFileSync(filename, 'utf8');
    const closureEnd = source.lastIndexOf('\n})();');
    assert.notEqual(closureEnd, -1, 'userscript IIFE end marker exists');
    const testState = {
        header: null,
        headers: [],
        currentReplyContext: null,
        sidebarGeometry: null,
        jumpCalls: [],
        activeSearch: null
    };
    const documentListeners = new Map();
    const windowListeners = new Map();
    const document = {
        readyState: 'loading',
        body: {},
        addEventListener(type, listener, options) {
            const listeners = documentListeners.get(type) || [];
            listeners.push({
                listener,
                capture: options === true || Boolean(options?.capture)
            });
            documentListeners.set(type, listeners);
        },
        dispatchClick(target) {
            const event = {
                type: 'click',
                target,
                defaultPrevented: false,
                propagationStopped: false,
                preventDefault() { this.defaultPrevented = true; },
                stopPropagation() { this.propagationStopped = true; }
            };
            for (const {listener, capture} of documentListeners.get('click') || []) {
                if (capture) listener(event);
            }
            for (let current = target; current && !event.propagationStopped;
                current = current.parentElement) {
                current.dispatchEvent?.(event);
            }
            return event;
        },
        querySelector() { return testState.header; },
        querySelectorAll(selector) {
            return selector === 'header, [role="banner"]'
                ? testState.headers
                : [];
        },
        createElement() { return makeTestElement(); },
        createElementNS() { return makeTestElement(); }
    };
    const window = {
        innerWidth: 1200,
        innerHeight: 800,
        addEventListener(type, listener) {
            const listeners = windowListeners.get(type) || [];
            listeners.push(listener);
            windowListeners.set(type, listeners);
        },
        dispatchStorage(event) {
            for (const listener of windowListeners.get('storage') || []) {
                listener(event);
            }
        },
        storageListenerCount() {
            return (windowListeners.get('storage') || []).length;
        },
        get localStorage() {
            return typeof localStorage === 'function'
                ? localStorage()
                : localStorage;
        },
        getComputedStyle(element) {
            return element.style || {
                display: 'block',
                visibility: 'visible',
                opacity: '1',
                getPropertyValue() { return ''; }
            };
        }
    };
    const instrumentation = `
        const testState = globalThis.__replyTestState;
        const renderReplyOutlineForTest = renderReplyOutline;
        globalThis.__replyNavigationTest = {
            install({ui, headerToolbar = null, outlineOpen = false,
                currentReplyContext = null, turns: testTurns = [],
                sidebarGeometry = null}) {
                initializeReplyOutlinePinnedPreference();
                replyNavigationUI = ui;
                replyTopButton = {hidden: false, dataset: {}};
                replyOutlineHeaderToolbar = headerToolbar;
                replyOutlineHeaderLookupAttempted = true;
                replyOutlineOpen = outlineOpen;
                replyNavigationContext = currentReplyContext;
                turns = testTurns;
                currentChatIdentity = 'chat-1';
                userScrollGeneration = 0;
                assistantReplyNavigationCursor = null;
                testState.currentReplyContext = currentReplyContext;
                testState.sidebarGeometry = sidebarGeometry;
                getCurrentReplyContext = () => testState.currentReplyContext;
                getReplySidebarGeometry = () => testState.sidebarGeometry;
                activeJumpSearch = null;
                jumpToIdentity = (...args) => {
                    testState.jumpCalls.push(args);
                    activeJumpSearch = {
                        identity: args[0],
                        chatIdentity: currentChatIdentity,
                        options: args[2],
                        userScrollGeneration,
                        settled: false,
                        cancelled: false
                    };
                    testState.activeSearch = activeJumpSearch;
                    return Promise.resolve();
                };
                testState.jumpCalls = [];
                testState.activeSearch = null;
                renderReplyOutline = () => {};
                syncReplyNavigationLayoutObservers = () => {};
                registerReplyOutlineOutsideClickHandling();
                bindReplyOutlinePinButton(ui.outlinePinButton);
                bindReplyOutlineToggleClickHandler(ui.outlineToggle);
                bindReplyOutlineToggleTooltipEvents(ui.outlineToggle);
                updateReplyOutlinePinButton();
            },
            setHeader(header) {
                testState.header = header;
                testState.headers = header ? [header] : [];
            },
            setHeaders(headers) {
                testState.headers = headers;
                testState.header = headers[0] || null;
            },
            findHeaderToolbar: findReplyOutlineHeaderToolbar,
            syncToggleBinding: syncReplyOutlineToggleBinding,
            setJumpToIdentity(fn) {
                jumpToIdentity = (...args) => {
                    testState.jumpCalls.push(args);
                    activeJumpSearch = {
                        identity: args[0],
                        chatIdentity: currentChatIdentity,
                        options: args[2],
                        userScrollGeneration,
                        settled: false,
                        cancelled: false
                    };
                    testState.activeSearch = activeJumpSearch;
                    return fn(...args);
                };
            },
            renderOutline(context, entries) {
                renderReplyOutlineForTest(context, entries);
            },
            setReplyOutlineOpen,
            click(target) { return document.dispatchClick(target); },
            initializeSettings: initializeReplyOutlinePinnedPreference,
            dispatchStorage(event) { return window.dispatchStorage(event); },
            storageListenerCount() { return window.storageListenerCount(); },
            directJump(identity, options = {replyTop: false}) {
                activeJumpSearch = {
                    identity,
                    chatIdentity: currentChatIdentity,
                    options,
                    userScrollGeneration,
                    settled: false,
                    cancelled: false
                };
                testState.activeSearch = activeJumpSearch;
            },
            finishActiveJump() {
                if (activeJumpSearch) activeJumpSearch.settled = true;
            },
            setCurrentReplyContext(context) {
                testState.currentReplyContext = context;
                replyNavigationContext = context;
            },
            clearPendingAssistantNavigation() {
                assistantReplyNavigationCursor = null;
            },
            jumpCalls() { return testState.jumpCalls; },
            navigateAssistantReply,
            updateAssistantReplyNavigationButtons,
            updateReplyTopButton,
            updateReplyNavigationControls,
            toggleReplyOutline,
            showTooltip: showReplyOutlineTooltip,
            hideTooltip: hideReplyOutlineTooltip,
            state() {
                return {
                    open: replyOutlineOpen,
                    rootHidden: replyNavigationUI.root.hidden,
                    toolbarHidden: replyNavigationUI.toolbar.hidden,
                    outlineHidden: replyNavigationUI.outline.hidden,
                    toggleHidden: replyNavigationUI.outlineToggle.hidden,
                    expanded: replyNavigationUI.outlineToggle.getAttribute('aria-expanded'),
                    pinned: replyOutlinePinned
                };
            }
        };
    `;
    const context = {
        __replyTestState: testState,
        document,
        window,
        console
    };
    vm.runInNewContext(
        `${source.slice(0, closureEnd)}${instrumentation}${source.slice(closureEnd)}`,
        context,
        {filename}
    );
    return context.__replyNavigationTest;
}

function makeNavigationTestUI() {
    const root = makeTestElement({hidden: false});
    const toolbar = makeTestElement({hidden: false});
    const outline = makeTestElement({hidden: false});
    const outlineToggle = makeTestElement({hidden: false});
    const outlineTooltip = makeTestElement({hidden: true});
    outlineTooltip.textContent = '展开大纲';
    const outlineHeadingRow = makeTestElement();
    const outlinePinButton = makeTestElement();
    const list = makeTestElement();
    list.replaceChildren = (...children) => {
        list.children = [];
        for (const child of children) list.appendChild(child);
    };
    const buttons = new Map([
        'previous-reply', 'first', 'up', 'down', 'last', 'next-reply'
    ].map(action => [
        action,
        {disabled: false}
    ]));
    const replyButtons = new Map(['previous', 'next'].map(direction => [
        direction,
        {disabled: false}
    ]));
    outline.appendChild(outlineHeadingRow);
    outlineHeadingRow.appendChild(outlinePinButton);
    toolbar.appendChild(outlineToggle);
    return {
        root,
        toolbar,
        outline,
        outlineToggle,
        outlineHeadingRow,
        outlinePinButton,
        outlineTooltip,
        list,
        buttons,
        replyButtons
    };
}

function configureOutlineSearch(root, {named = [], flex = [], buttons = []} = {}) {
    root.querySelectorAll = selector => {
        if (selector === '[class*="Toolbar-"]') return named;
        if (selector === '[role="toolbar"]') {
            return named.filter(element => element.getAttribute('role') === 'toolbar');
        }
        if (selector === 'div.flex, div[class*="flex"]') return flex;
        if (selector === 'button, [role="button"]') return buttons;
        return [];
    };
    root.querySelector = selector =>
        selector === 'button, [role="button"]' ? buttons[0] || null : null;
}

function makeTestParent() {
    const parent = makeTestElement();
    parent.insertBefore = (element, reference) => {
        element.remove();
        const index = reference ? parent.children.indexOf(reference) : parent.children.length;
        parent.children.splice(index, 0, element);
        element.parentElement = parent;
        element.isConnected = true;
    };
    Object.defineProperty(parent, 'firstElementChild', {
        get() { return parent.children[0] || null; }
    });
    return parent;
}

function makeTestElement({
    hidden = false,
    rect = {left: 872, right: 952, top: 8, bottom: 48, width: 80, height: 40},
    closest = () => null,
    querySelector = () => null,
    matches = () => false
} = {}) {
    const attributes = new Map();
    const eventListeners = new Map();
    const element = {
        hidden,
        rect,
        isConnected: true,
        parentElement: null,
        children: [],
        style: {
            removeProperty(name) { delete this[name]; },
            getPropertyValue(name) { return this[name] || ''; },
            setProperty(name, value) { this[name] = value; }
        },
        dataset: {},
        closest,
        querySelector,
        matches,
        contains(target) {
            for (let current = target; current; current = current.parentElement) {
                if (current === this) return true;
            }
            return false;
        },
        get nextElementSibling() {
            if (!this.parentElement) return null;
            const siblings = this.parentElement.children;
            return siblings[siblings.indexOf(this) + 1] || null;
        },
        getBoundingClientRect() { return this.rect; },
        setAttribute(name, value) { attributes.set(name, String(value)); },
        getAttribute(name) { return attributes.get(name) ?? null; },
        addEventListener(type, listener) {
            const listeners = eventListeners.get(type) || [];
            listeners.push(listener);
            eventListeners.set(type, listeners);
        },
        dispatchEvent(event) {
            for (const listener of eventListeners.get(event.type) || []) {
                listener.call(this, event);
            }
            return !event.defaultPrevented;
        },
        appendChild(child) {
            child.parentElement = this;
            child.isConnected = true;
            this.children.push(child);
            return child;
        },
        replaceChildren(...children) {
            for (const child of this.children) {
                child.parentElement = null;
                child.isConnected = false;
            }
            this.children = [];
            for (const child of children) this.appendChild(child);
        },
        remove() {
            if (this.parentElement) {
                const index = this.parentElement.children.indexOf(this);
                if (index >= 0) this.parentElement.children.splice(index, 1);
            }
            this.parentElement = null;
            this.isConnected = false;
        }
    };
    return element;
}
