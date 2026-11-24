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
    computeReplyOutlineTogglePosition,
    computeReplyOutlinePosition,
    computeReplyOutlineTooltipPosition,
    computeReplyContentShift,
    composeThreadContentX
} = require('./chatgpt-conversation-navigator.user.js');

const REPLY_OUTLINE_PINNED_STORAGE_KEY =
    'yw-chatgpt-conversation-navigator:reply-outline-pinned';
const REPLY_OUTLINE_OPEN_STORAGE_KEY =
    'yw-chatgpt-conversation-navigator:reply-outline-open';

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

test('reply heading discovery supports legacy Heading-Ro3lZr headings', () => {
    const runtime = loadReplyNavigationRuntime();
    const reply = makeReplyHeadingRoot([
        {tagName: 'H1', className: 'Heading-Ro3lZr', text: 'Overview'},
        {tagName: 'H3', className: 'Heading-Ro3lZr', text: 'Details'}
    ]);

    assert.deepEqual(
        summarizeReplyHeadingEntries(runtime, reply),
        [
            {text: 'Overview', level: 1},
            {text: 'Details', level: 3}
        ]
    );
});

test('reply heading discovery supports semantic title attributes across h1-h6', () => {
    const runtime = loadReplyNavigationRuntime();
    const reply = makeReplyHeadingRoot([
        {
            tagName: 'H1',
            className: 'TextBase-qM5iDq Title-mwq_Iy',
            dataComponent: 'title',
            text: 'New title class'
        },
        {
            tagName: 'H2',
            className: 'RenamedHeading-a1b2c3',
            dataComponent: 'title',
            text: 'Renamed heading class'
        },
        {tagName: 'H3', dataComponent: 'title', text: 'Classless heading'},
        {
            tagName: 'H4',
            className: 'AnotherRenamedHeading-xYz',
            dataComponent: 'title',
            text: 'Another renamed heading class'
        },
        {tagName: 'H5', dataComponent: 'title', text: 'Classless deep heading'},
        {
            tagName: 'H6',
            className: 'TextBase-new Title-newHash',
            dataComponent: 'title',
            text: 'Deep semantic title'
        }
    ]);

    assert.deepEqual(
        summarizeReplyHeadingEntries(runtime, reply),
        [
            {text: 'New title class', level: 1},
            {text: 'Renamed heading class', level: 2},
            {text: 'Classless heading', level: 3},
            {text: 'Another renamed heading class', level: 4},
            {text: 'Classless deep heading', level: 5},
            {text: 'Deep semantic title', level: 6}
        ]
    );
});

test('mixed reply heading variants keep DOM order and levels within the current reply', () => {
    const runtime = loadReplyNavigationRuntime();
    const reply = makeReplyHeadingRoot([
        {
            tagName: 'H3',
            className: 'TextBase-qM5iDq Title-mwq_Iy',
            dataComponent: 'title',
            text: 'New first'
        },
        {tagName: 'H1', className: 'Heading-Ro3lZr', text: 'Old second'},
        {tagName: 'H5', className: 'Heading-Ro3lZr', text: 'Old third'},
        {
            tagName: 'H2',
            className: 'RenamedTitle-kLmNoP',
            dataComponent: 'title',
            text: 'New fourth'
        },
        {tagName: 'H4', className: 'OtherHeadingClass', text: 'Unrelated class'},
        {tagName: 'DIV', className: 'Title-mwq_Iy', dataComponent: 'title', text: 'Not a heading'}
    ]);
    const conversation = makeTestElement();
    const otherReply = makeReplyHeadingRoot([
        {tagName: 'H2', className: 'Heading-Ro3lZr', text: 'Other reply'}
    ]);
    conversation.appendChild(reply);
    conversation.appendChild(otherReply);

    assert.deepEqual(
        summarizeReplyHeadingEntries(runtime, reply),
        [
            {text: 'New first', level: 3},
            {text: 'Old second', level: 1},
            {text: 'Old third', level: 5},
            {text: 'New fourth', level: 2}
        ]
    );
});

test('reply heading discovery excludes headings inside semantic box containers', () => {
    const runtime = loadReplyNavigationRuntime();
    const reply = makeReplyHeadingRoot([
        {
            tagName: 'H2',
            className: 'TextBase-qM5iDq Title-mwq_Iy',
            dataComponent: 'title',
            text: 'Before Box'
        },
        {
            tagName: 'DIV',
            className: 'Grid-CGRmTR',
            children: [
                {
                    tagName: 'DIV',
                    className: 'Box-renamedClass',
                    dataComponent: 'box',
                    children: [
                        {
                            tagName: 'H1',
                            className: 'Title-mwq_Iy',
                            dataComponent: 'title',
                            text: 'Direct Box heading'
                        },
                        {
                            tagName: 'SPAN',
                            dataComponent: 'box',
                            children: [
                                {tagName: 'H6', className: 'Heading-Ro3lZr', text: 'Nested Box heading'}
                            ]
                        }
                    ]
                }
            ]
        },
        {
            tagName: 'DIV',
            dataComponent: 'box',
            children: [
                {tagName: 'H3', className: 'Title-newHash', dataComponent: 'title', text: 'Box without grid'}
            ]
        },
        {
            tagName: 'DIV',
            className: 'Box-classOnly',
            children: [
                {tagName: 'H4', className: 'Heading-Ro3lZr', text: 'Other Box class'}
            ]
        },
        {
            tagName: 'SECTION',
            className: 'Box-classOnly',
            children: [
                {tagName: 'H5', className: 'Heading-Ro3lZr', text: 'Non-box heading'}
            ]
        },
        {tagName: 'H2', className: 'Heading-Ro3lZr', text: 'After Box'}
    ]);
    const conversation = makeTestElement();
    const otherReply = makeReplyHeadingRoot([
        {tagName: 'H1', className: 'Title-mwq_Iy', dataComponent: 'title', text: 'Other reply'}
    ]);
    conversation.appendChild(reply);
    conversation.appendChild(otherReply);

    assert.deepEqual(
        summarizeReplyHeadingEntries(runtime, reply),
        [
            {text: 'Before Box', level: 2},
            {text: 'Other Box class', level: 4},
            {text: 'Non-box heading', level: 5},
            {text: 'After Box', level: 2}
        ]
    );
    assert.deepEqual(
        summarizeReplyHeadingEntries(runtime, otherReply),
        [{text: 'Other reply', level: 1}]
    );
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

test('repeated scroll-range extensions restore the first original padding and priority', () => {
    for (const priority of ['', 'important']) {
        const runtime = loadReplyNavigationRuntime();
        const context = makeScrollRangeTestContext('10px', priority);
        runtime.extendScrollRange(context, 190);
        assert.equal(context.container.style.getPropertyValue('padding-bottom'), '102px');
        runtime.extendScrollRange(context, 240);
        assert.equal(context.container.style.getPropertyValue('padding-bottom'), '152px');
        runtime.clearScrollRange();

        assert.equal(context.container.style.getPropertyValue('padding-bottom'), '10px');
        assert.equal(context.container.style.getPropertyPriority('padding-bottom'), priority);
    }
});

test('switching scroll-range containers restores each container original padding', () => {
    const runtime = loadReplyNavigationRuntime();
    const first = makeScrollRangeTestContext('10px', 'important');
    const second = makeScrollRangeTestContext('20px', '');
    runtime.extendScrollRange(first, 190);
    runtime.extendScrollRange(second, 240);

    assert.equal(first.container.style.getPropertyValue('padding-bottom'), '10px');
    assert.equal(first.container.style.getPropertyPriority('padding-bottom'), 'important');
    assert.notEqual(second.container.style.getPropertyValue('padding-bottom'), '20px');
    runtime.clearScrollRange();
    assert.equal(second.container.style.getPropertyValue('padding-bottom'), '20px');
    assert.equal(second.container.style.getPropertyPriority('padding-bottom'), '');
});

test('scroll-range cleanup preserves padding changed by an outside owner', () => {
    const runtime = loadReplyNavigationRuntime();
    const context = makeScrollRangeTestContext('10px', '');
    runtime.extendScrollRange(context, 190);
    context.container.style.setProperty('padding-bottom', '77px', 'important');
    runtime.clearScrollRange();
    assert.equal(context.container.style.getPropertyValue('padding-bottom'), '77px');
    assert.equal(context.container.style.getPropertyPriority('padding-bottom'), 'important');

    runtime.extendScrollRange(context, 240);
    context.container.style.setProperty('padding-bottom', '55px', '');
    runtime.extendScrollRange(context, 280);
    runtime.clearScrollRange();
    assert.equal(context.container.style.getPropertyValue('padding-bottom'), '55px');
    assert.equal(context.container.style.getPropertyPriority('padding-bottom'), '');

    runtime.extendScrollRange(context, 300);
    const appliedValue = context.container.style.getPropertyValue('padding-bottom');
    context.container.style.setProperty('padding-bottom', appliedValue, '');
    runtime.clearScrollRange();
    assert.equal(context.container.style.getPropertyValue('padding-bottom'), appliedValue);
    assert.equal(context.container.style.getPropertyPriority('padding-bottom'), '');
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

test('outline panel opens after the control rail and shrinks to available width', () => {
    assert.deepEqual(computeReplyOutlinePosition({
        windowWidth: 1200,
        windowHeight: 800,
        toolbarLeft: 260,
        toolbarWidth: 32
    }), {
        left: 304,
        width: 300,
        maxHeight: 560,
        visible: true
    });
    assert.deepEqual(computeReplyOutlinePosition({
        windowWidth: 300,
        windowHeight: 180,
        toolbarLeft: 64,
        toolbarWidth: 32
    }), {
        left: 108,
        width: 184,
        maxHeight: 164,
        visible: true
    });
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 600,
        windowHeight: 800,
        toolbarLeft: 260,
        toolbarWidth: 32
    }).width, 288, 'panel uses the space after the control rail');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 480,
        windowHeight: 800,
        toolbarLeft: 260,
        toolbarWidth: 32
    }).width, 168, 'panel shrinks to the space after the control rail');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 1200,
        windowHeight: 800,
        toolbarLeft: 24,
        toolbarWidth: 32
    }).left, 68, 'collapsed sidebar uses the control rail right edge');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 1200,
        windowHeight: 800,
        toolbarWidth: 32
    }), null, 'missing control rail geometry leaves the panel hidden');
    assert.equal(computeReplyOutlinePosition({
        windowWidth: 600,
        windowHeight: 500,
        toolbarLeft: 200,
        toolbarWidth: 32
    }).visible, true);
});

test('standalone outline toggle is centered one button above the control rail', () => {
    assert.deepEqual(computeReplyOutlineTogglePosition({
        windowWidth: 1200,
        windowHeight: 800,
        toolbarLeft: 292,
        toolbarTop: 299,
        toolbarWidth: 32,
        toggleWidth: 32,
        toggleHeight: 32,
        buttonGap: 32
    }), {
        left: 292,
        top: 235,
        visible: true
    });
    assert.deepEqual(computeReplyOutlineTogglePosition({
        windowWidth: 1200,
        windowHeight: 800,
        toolbarLeft: 252,
        toolbarTop: 20,
        toolbarWidth: 32,
        toggleWidth: 32,
        toggleHeight: 32,
        buttonGap: 32
    }), {
        left: 252,
        top: 8,
        visible: true
    });
});

test('control toolbar hover and capsule tooltip match the outline controls', () => {
    const source = require('node:fs').readFileSync(
        require.resolve('./chatgpt-conversation-navigator.user.js'),
        'utf8'
    );
    assert.match(
        source,
        /\.yw-reply-nav-button:hover,[\s\S]*?background:\s*#EFEFEF;/
    );
    assert.match(
        source,
        /\.yw-history-control:hover,[\s\S]*?background:\s*#EFEFEF;/
    );
    assert.match(
        source,
        /\.yw-reply-nav-button::after\s*\{[\s\S]*?content:\s*attr\(aria-label\);/
    );
    assert.match(
        source,
        /\.yw-reply-nav-button::after\s*\{[\s\S]*?left:\s*calc\(100% \+ \$\{REPLY_NAV_TOOLTIP_GAP\}px\);/
    );
    assert.match(
        source,
        /\.yw-reply-nav-button:hover::after,[\s\S]*?visibility:\s*visible;/
    );
});

test('outline content shift applies one fixed 154px move when it fits', () => {
    assert.equal(computeReplyContentShift({
        contentRight: 1236,
        rightBoundary: 1400
    }), 154);
    assert.equal(computeReplyContentShift({
        contentRight: 1370,
        rightBoundary: 1395,
        contentGap: 8
    }), 0);
    assert.equal(computeReplyContentShift({
        contentRight: 1320,
        rightBoundary: 1395
    }), 0);
    assert.equal(composeThreadContentX('', 154), '154px');
    assert.equal(composeThreadContentX('154px', 154), '308px');
    assert.equal(composeThreadContentX('-154px', 154), '0px');
    assert.equal(composeThreadContentX('calc(100% - 1px)', 8),
        'calc(calc(100% - 1px) + 8px)');
});

test('outline content shift animates both into place and back out', () => {
    const runtime = loadReplyNavigationRuntime();
    const layout = makeTestElement();
    layout.className = 'group/thread-scroll-layout';

    runtime.applyContentShift(layout, 154, 'chat-1', true);
    assert.equal(runtime.pendingAnimations(), 1);
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '');

    runtime.advanceAnimation(50);
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '135px');
    assert.equal(runtime.pendingAnimations(), 1);

    runtime.advanceAnimation(50);
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '154px');
    assert.equal(runtime.pendingAnimations(), 0);

    runtime.restoreContentShift({animate: true});
    assert.equal(runtime.pendingAnimations(), 1);
    runtime.advanceAnimation(50);
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '19px');
    runtime.advanceAnimation(50);
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '');
    assert.equal(runtime.pendingAnimations(), 0);
    assert.equal(runtime.contentShiftState(), null);
});

test('outline display preserves every entry’s native level', () => {
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
    ), ['30px', '14px', '46px']);
    assert.deepEqual(entries.map(entry => entry.level), [4, 2, 6]);
});

test('outline tooltip stays static while the accessible toggle label follows open state', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const context = {reply: {isConnected: true}};
    runtime.install({ui, currentReplyContext: context});

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

test('outline preferences restore only exact saved true values for new runtimes', () => {
    const storage = makeTestStorage([
        [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'true'],
        [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'true']
    ]);
    const restoredRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const restoredUI = makeNavigationTestUI();
    restoredRuntime.install({ui: restoredUI});

    assert.equal(restoredRuntime.state().pinned, true);
    assert.equal(restoredRuntime.state().open, true);
    assert.equal(restoredUI.outlinePinButton.getAttribute('aria-pressed'), 'true');
    assert.equal(restoredRuntime.storageListenerCount(), 0);

    storage.setItem(REPLY_OUTLINE_PINNED_STORAGE_KEY, 'false');
    const restoredOffRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const restoredOffUI = makeNavigationTestUI();
    restoredOffRuntime.install({ui: restoredOffUI});
    assert.equal(restoredOffRuntime.state().pinned, false);
    assert.equal(restoredOffRuntime.state().open, false);
    assert.equal(restoredOffUI.outlinePinButton.getAttribute('aria-pressed'), 'false');

    storage.setItem(REPLY_OUTLINE_PINNED_STORAGE_KEY, 'True');
    const invalidValueRuntime = loadReplyNavigationRuntime({localStorage: storage});
    const invalidValueUI = makeNavigationTestUI();
    invalidValueRuntime.install({ui: invalidValueUI});
    assert.equal(invalidValueRuntime.state().pinned, false);
    assert.equal(invalidValueRuntime.state().open, false);
});

test('saved open preference requires both pinned and open without implicit pin migration', () => {
    const cases = [
        {pinned: 'true', open: 'true', expectedPinned: true, expectedOpen: true},
        {pinned: 'true', open: 'false', expectedPinned: true, expectedOpen: false},
        {pinned: 'true', open: null, expectedPinned: true, expectedOpen: false},
        {pinned: 'false', open: 'true', expectedPinned: false, expectedOpen: false},
        {pinned: 'false', open: 'false', expectedPinned: false, expectedOpen: false},
        {pinned: 'True', open: 'true', expectedPinned: false, expectedOpen: false},
        {pinned: 'true', open: 'True', expectedPinned: true, expectedOpen: false}
    ];

    for (const preference of cases) {
        const entries = [[REPLY_OUTLINE_PINNED_STORAGE_KEY, preference.pinned]];
        if (preference.open !== null) {
            entries.push([REPLY_OUTLINE_OPEN_STORAGE_KEY, preference.open]);
        }
        const runtime = loadReplyNavigationRuntime({
            localStorage: makeTestStorage(entries)
        });
        runtime.install({ui: makeNavigationTestUI()});

        assert.equal(runtime.state().pinned, preference.expectedPinned, preference.pinned);
        assert.equal(runtime.state().open, preference.expectedOpen, preference.open);
        assert.equal(
            runtime.state().openPreference,
            preference.open === 'true',
            `saved open intent for ${preference.open}`
        );
    }
});

test('explicit open state persists independently of pin state', () => {
    const storage = makeTestStorage([
        [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'false']
    ]);
    const runtime = loadReplyNavigationRuntime({localStorage: storage});
    const ui = makeNavigationTestUI();
    const context = {reply: {isConnected: true}};
    runtime.install({ui, currentReplyContext: context});

    runtime.setReplyOutlineOpen(true);
    assert.equal(runtime.state().pinned, false);
    assert.equal(runtime.state().open, true);
    assert.equal(runtime.state().openPreference, true);
    assert.equal(storage.getItem(REPLY_OUTLINE_OPEN_STORAGE_KEY), 'true');

    const unpinnedReload = loadReplyNavigationRuntime({localStorage: storage});
    unpinnedReload.install({ui: makeNavigationTestUI()});
    assert.equal(unpinnedReload.state().pinned, false);
    assert.equal(unpinnedReload.state().openPreference, true);
    assert.equal(unpinnedReload.state().open, false);

    runtime.click(ui.outlinePinButton);
    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, true);
    assert.equal(storage.getItem(REPLY_OUTLINE_OPEN_STORAGE_KEY), 'true');

    const pinnedReload = loadReplyNavigationRuntime({localStorage: storage});
    pinnedReload.install({ui: makeNavigationTestUI()});
    assert.equal(pinnedReload.state().pinned, true);
    assert.equal(pinnedReload.state().open, true);
});

test('unset or unavailable pin preference starts with the outline closed', () => {
    for (const localStorage of [
        undefined,
        () => { throw new Error('blocked localStorage'); }
    ]) {
        const runtime = loadReplyNavigationRuntime({localStorage});
        runtime.install({ui: makeNavigationTestUI()});

        assert.equal(runtime.state().pinned, false);
        assert.equal(runtime.state().open, false);
    }
});

test('saved pin opens before UI creation and shows the outline when a reply becomes ready', () => {
    const storage = makeTestStorage([
        [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'true'],
        [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'true']
    ]);
    const runtime = loadReplyNavigationRuntime({localStorage: storage});
    const ui = makeNavigationTestUI();
    ui.root.hidden = true;
    ui.outline.hidden = true;
    ui.outlineToggle.hidden = true;
    runtime.install({ui});

    assert.equal(runtime.preUIPreference().pinned, true);
    assert.equal(runtime.preUIPreference().open, true);
    assert.equal(runtime.state().open, true);
    assert.equal(runtime.state().rootHidden, true);

    const reply = makeReplyHeadingRoot([
        {
            tagName: 'H2',
            className: 'TextBase-qM5iDq Title-mwq_Iy',
            dataComponent: 'title',
            text: 'Chapter'
        }
    ]);
    const currentReplyContext = {
        identity: 'reply-1',
        chatIdentity: 'chat-1',
        reply,
        rect: {left: 300, right: 700, top: 100, bottom: 800, width: 400},
        visibleTop: 200,
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    };
    runtime.setCurrentReplyContext(currentReplyContext);
    runtime.updateReplyNavigationControls(currentReplyContext, []);

    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, true);
    assert.equal(runtime.state().rootHidden, false);
    assert.equal(runtime.state().outlineHidden, false);
});

test('pin preference persists separately while open tabs ignore storage events', () => {
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
    assert.equal(storage.getItem(REPLY_OUTLINE_OPEN_STORAGE_KEY), null);
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
    assert.equal(restoredPinnedRuntime.state().open, false);

    restoredPinnedRuntime.click(restoredPinnedUI.outlinePinButton);
    assert.equal(storage.getItem(REPLY_OUTLINE_PINNED_STORAGE_KEY), 'false');
    assert.equal(restoredPinnedRuntime.state().open, false);
    assert.equal(storage.getItem(REPLY_OUTLINE_OPEN_STORAGE_KEY), 'false');
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
    assert.equal(restoredUnpinnedRuntime.state().open, false);
});

test('pinned and saved-open outline reopens on a conversation route change', () => {
    const storage = makeTestStorage([
        [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'true'],
        [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'true']
    ]);
    const runtime = loadReplyNavigationRuntime({localStorage: storage});
    const ui = makeNavigationTestUI();
    const oldContext = {
        identity: 'old-reply',
        chatIdentity: 'conversation:old',
        reply: makeReplyHeadingRoot([]),
        visibleTop: 200,
        rect: {left: 300, right: 700, top: 100, bottom: 800, width: 400},
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    };
    runtime.install({ui, currentReplyContext: oldContext});
    runtime.setCurrentChatIdentity('conversation:old');
    runtime.setPathname('/c/old');
    runtime.stubRouteNativeStartup();
    runtime.renderOutline(oldContext, [
        {element: makeTestElement(), text: 'Old chapter', level: 1}
    ]);
    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, true);
    assert.equal(runtime.state().openPreference, true);
    assert.equal(ui.list.children.length, 1);

    // Route resets use this tab's saved intent, even if shared storage changes.
    storage.setItem(REPLY_OUTLINE_PINNED_STORAGE_KEY, 'false');
    storage.setItem(REPLY_OUTLINE_OPEN_STORAGE_KEY, 'false');
    runtime.handleRouteChange();
    assert.equal(runtime.state().open, true, 'same-identity updates preserve current state');
    assert.equal(ui.list.children.length, 1);

    runtime.setPathname('/c/new');
    runtime.handleRouteChange();
    assert.equal(runtime.currentChatIdentity(), 'conversation:new');
    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, true);
    assert.equal(runtime.state().rootHidden, true);
    assert.equal(runtime.replyNavigationContext(), null);
    assert.equal(ui.list.children.length, 0);
    assert.equal(ui.outlineEntries.length, 0);
    assert.equal(ui.outlineChatIdentity, null);
    assert.equal(ui.outlineIdentity, null);
    assert.equal(ui.outlineReply, null);

    const newContext = {
        ...oldContext,
        identity: 'new-reply',
        chatIdentity: 'conversation:new',
        reply: makeReplyHeadingRoot([])
    };
    runtime.setCurrentReplyContext(newContext);
    runtime.updateReplyNavigationControls(newContext, []);
    assert.equal(runtime.state().open, true);
    assert.equal(runtime.state().rootHidden, false);
    assert.equal(runtime.state().outlineHidden, false);
});

test('pinned closed outline stays closed on route changes and after reload', () => {
    const storage = makeTestStorage([
        [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'true'],
        [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'true']
    ]);
    const runtime = loadReplyNavigationRuntime({localStorage: storage});
    const ui = makeNavigationTestUI();
    const oldContext = {
        identity: 'old-reply',
        chatIdentity: 'conversation:old',
        reply: makeReplyHeadingRoot([]),
        visibleTop: 200,
        rect: {left: 300, right: 700, top: 100, bottom: 800, width: 400},
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    };
    runtime.install({ui, currentReplyContext: oldContext});
    runtime.setCurrentChatIdentity('conversation:old');
    runtime.setPathname('/c/old');
    runtime.stubRouteNativeStartup();
    runtime.setReplyOutlineOpen(false);
    assert.equal(storage.getItem(REPLY_OUTLINE_OPEN_STORAGE_KEY), 'false');
    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, false);

    runtime.setPathname('/c/new');
    runtime.handleRouteChange();
    assert.equal(runtime.currentChatIdentity(), 'conversation:new');
    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, false);
    assert.equal(runtime.state().openPreference, false);
    assert.equal(runtime.state().rootHidden, true);

    const reloadedRuntime = loadReplyNavigationRuntime({localStorage: storage});
    reloadedRuntime.install({ui: makeNavigationTestUI()});
    assert.equal(reloadedRuntime.state().pinned, true);
    assert.equal(reloadedRuntime.state().open, false);
});

test('unpinned outline stays closed across a conversation route change', () => {
    const runtime = loadReplyNavigationRuntime({
        localStorage: makeTestStorage([
            [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'false'],
            [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'true']
        ])
    });
    const ui = makeNavigationTestUI();
    const oldContext = {
        identity: 'old-reply',
        chatIdentity: 'conversation:old',
        reply: makeReplyHeadingRoot([]),
        visibleTop: 200,
        rect: {left: 300, right: 700, top: 100, bottom: 800, width: 400},
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    };
    runtime.install({ui, currentReplyContext: oldContext});
    runtime.setCurrentChatIdentity('conversation:old');
    runtime.setPathname('/c/old');
    runtime.stubRouteNativeStartup();

    runtime.setPathname('/c/new');
    runtime.handleRouteChange();
    assert.equal(runtime.currentChatIdentity(), 'conversation:new');
    assert.equal(runtime.state().pinned, false);
    assert.equal(runtime.state().open, false);
    assert.equal(runtime.state().rootHidden, true);

    const newContext = {
        ...oldContext,
        identity: 'new-reply',
        chatIdentity: 'conversation:new',
        reply: makeReplyHeadingRoot([])
    };
    runtime.setCurrentReplyContext(newContext);
    runtime.updateReplyNavigationControls(newContext, []);
    assert.equal(runtime.state().rootHidden, false);
    assert.equal(runtime.state().outlineHidden, true);
});

test('pinned outline is restored through pending new-conversation URL adoption', () => {
    const runtime = loadReplyNavigationRuntime({
        localStorage: makeTestStorage([
            [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'true'],
            [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'true']
        ])
    });
    const ui = makeNavigationTestUI();
    runtime.install({ui, outlineOpen: false});
    runtime.setCurrentChatIdentity('route:/');
    runtime.setPathname('/');
    runtime.setNewConversationSubmissionPending(true);
    runtime.stubRouteNativeStartup();

    runtime.setPathname('/c/created');
    runtime.handleRouteChange();

    assert.equal(runtime.currentChatIdentity(), 'conversation:created');
    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, true);
    assert.equal(runtime.state().rootHidden, true);
    assert.equal(runtime.replyNavigationContext(), null);
});

test('pinned closed outline stays closed through pending new-conversation adoption', () => {
    const runtime = loadReplyNavigationRuntime({
        localStorage: makeTestStorage([
            [REPLY_OUTLINE_PINNED_STORAGE_KEY, 'true'],
            [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'false']
        ])
    });
    const ui = makeNavigationTestUI();
    runtime.install({ui});
    runtime.setCurrentChatIdentity('route:/');
    runtime.setPathname('/');
    runtime.setNewConversationSubmissionPending(true);
    runtime.stubRouteNativeStartup();

    runtime.setPathname('/c/created');
    runtime.handleRouteChange();

    assert.equal(runtime.currentChatIdentity(), 'conversation:created');
    assert.equal(runtime.state().pinned, true);
    assert.equal(runtime.state().open, false);
    assert.equal(runtime.state().rootHidden, true);
    assert.equal(runtime.replyNavigationContext(), null);
});

test('pin and open preferences remain usable when localStorage is unavailable or throws', () => {
    for (const localStorage of [
        undefined,
        () => { throw new Error('blocked localStorage'); }
    ]) {
        const runtime = loadReplyNavigationRuntime({localStorage});
        const ui = makeNavigationTestUI();
        runtime.install({
            ui,
            currentReplyContext: {reply: {isConnected: true}}
        });

        assert.equal(ui.outlinePinButton.getAttribute('aria-pressed'), 'false');
        runtime.click(ui.outlinePinButton);
        assert.equal(runtime.state().pinned, true);
        assert.equal(ui.outlinePinButton.getAttribute('aria-pressed'), 'true');
        assert.equal(runtime.state().open, false, 'pinning does not open a closed outline');
        runtime.setReplyOutlineOpen(true);
        assert.equal(runtime.state().open, true);
        assert.equal(runtime.state().openPreference, true);
        runtime.setReplyOutlineOpen(false);
        assert.equal(runtime.state().open, false);
        assert.equal(runtime.state().openPreference, false);
    }
});

test('outline pin starts off and toggles its icon and accessibility state without closing', () => {
    const storage = makeTestStorage();
    const runtime = loadReplyNavigationRuntime({localStorage: storage});
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
    assert.equal(runtime.state().openPreference, false);
    assert.equal(storage.getItem(REPLY_OUTLINE_OPEN_STORAGE_KEY), null);
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
    assert.equal(runtime.state().openPreference, false);
});

test('outside clicks collapse an unpinned outline and preserve a pinned one', () => {
    const unpinnedStorage = makeTestStorage([
        [REPLY_OUTLINE_OPEN_STORAGE_KEY, 'true']
    ]);
    const unpinnedRuntime = loadReplyNavigationRuntime({localStorage: unpinnedStorage});
    const unpinnedUI = makeNavigationTestUI();
    unpinnedRuntime.install({
        ui: unpinnedUI,
        outlineOpen: true,
        currentReplyContext: {reply: {isConnected: true}}
    });

    unpinnedRuntime.click(makeTestElement());
    assert.equal(unpinnedRuntime.state().open, false);
    assert.equal(unpinnedRuntime.state().openPreference, false);
    assert.equal(unpinnedStorage.getItem(REPLY_OUTLINE_OPEN_STORAGE_KEY), 'false');
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
    runtime.install({ui, currentReplyContext: context});

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

test('outline opens with the list aligned to the toggle and room to scroll below', () => {
    const runtime = loadReplyNavigationRuntime({windowHeight: 600});
    const ui = makeNavigationTestUI();
    ui.toolbar.hidden = false;
    ui.toolbar.rect = {
        left: 292,
        right: 324,
        top: 199,
        bottom: 401,
        width: 32,
        height: 202
    };
    ui.outline.rect = {
        left: 336,
        right: 636,
        top: 227.5,
        bottom: 372.5,
        width: 300,
        height: 145
    };
    ui.list.rect = {...ui.outline.rect, top: 274.5, height: 98};
    ui.outlineToggle.rect = {
        left: 292,
        right: 324,
        top: 135,
        bottom: 167,
        width: 32,
        height: 32
    };
    const reply = makeTestElement();
    reply.querySelectorAll = () => [];
    reply.matches = () => false;
    const context = {
        identity: 'reply-1',
        chatIdentity: 'chat-1',
        reply,
        rect: {left: 420, right: 900, top: 100, bottom: 700, width: 480, height: 600},
        visibleTop: 80,
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    };
    runtime.install({ui, currentReplyContext: context});

    runtime.setReplyOutlineOpen(true);
    assert.equal(ui.outline.hidden, false);
    assert.equal(ui.outline.style.left, '336px');
    assert.equal(ui.outline.style.width, '300px');
    assert.equal(ui.outline.style.maxHeight, '504px');
    assert.equal(ui.outline.style.top, '88px');
});

test('body-level outline tooltip opens to the right of the icon and clamps at viewport edges', () => {
    assert.deepEqual(computeReplyOutlineTooltipPosition({
        windowWidth: 1000,
        windowHeight: 600,
        anchorLeft: 900,
        anchorRight: 980,
        anchorTop: 12,
        anchorHeight: 38,
        tooltipWidth: 130,
        tooltipHeight: 28
    }), {left: 862, top: 17, width: 130, height: 28});
    assert.deepEqual(computeReplyOutlineTooltipPosition({
        windowWidth: 320,
        windowHeight: 180,
        anchorLeft: 0,
        anchorRight: 64,
        anchorTop: 170,
        anchorHeight: 40,
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
    assert.equal(ui.outlineTooltip.style.top, '17px');

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
    runtime.install({ui, currentReplyContext: context});

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
    runtime.install({ui, currentReplyContext: context});

    runtime.showTooltip();
    ui.outlineToggle.rect = {
        left: 800, right: 880, top: 100, bottom: 138, width: 80, height: 38
    };
    runtime.updateReplyTopButton();
    assert.equal(ui.outlineTooltip.hidden, false);
    assert.equal(ui.outlineTooltip.style.left, '896px');
    assert.equal(ui.outlineTooltip.style.top, '105px');
});

test('content shift ignores hidden conversation layouts and does not accumulate', () => {
    const runtime = loadReplyNavigationRuntime();
    const hiddenLayout = makeTestElement({
        rect: {left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0}
    });
    hiddenLayout.className = 'group/thread-scroll-layout';
    const inactiveLayout = makeTestElement({
        rect: {left: 240, right: 1040, top: 0, bottom: 800, width: 800, height: 800}
    });
    inactiveLayout.className = 'group/thread-scroll-layout';
    const activeLayout = makeTestElement({
        rect: {left: 240, right: 1040, top: 0, bottom: 800, width: 800, height: 800}
    });
    activeLayout.className = 'group/thread-scroll-layout';
    const reply = makeTestElement();
    activeLayout.appendChild(reply);
    runtime.setContentLayouts([hiddenLayout, inactiveLayout, activeLayout]);

    assert.equal(runtime.findContentLayout({reply}), activeLayout);

    runtime.applyContentShift(activeLayout, 154, 'chat-1');
    runtime.applyContentShift(activeLayout, 154, 'chat-1');
    assert.equal(activeLayout.style.getPropertyValue('--thread-content-x'), '154px');
    assert.equal(hiddenLayout.style.getPropertyValue('--thread-content-x'), '');

    runtime.applyContentShift(activeLayout, 154, 'chat-2');
    assert.equal(activeLayout.style.getPropertyValue('--thread-content-x'), '154px');
    assert.equal(runtime.contentShiftState().chatIdentity, 'chat-2');

    runtime.restoreContentShift();
    assert.equal(activeLayout.style.getPropertyValue('--thread-content-x'), '');

    runtime.applyContentShift(activeLayout, 0, 'chat-3');
    activeLayout.style.setProperty('--thread-content-x', '-154px');
    runtime.restoreContentShift();
    assert.equal(
        activeLayout.style.getPropertyValue('--thread-content-x'),
        '-154px'
    );
});

test('pinned outline stays hidden through a reply gap until its button can load', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    runtime.install({ui, outlineOpen: true, currentReplyContext: null});

    runtime.updateReplyTopButton();
    const state = runtime.state();
    assert.equal(state.open, true);
    assert.equal(state.rootHidden, true);
    assert.equal(state.toolbarHidden, true);
    assert.equal(state.outlineHidden, true);
    assert.equal(state.toggleHidden, true);
    assert.equal(state.expanded, 'false');
    assert.equal(ui.list.children.length, 0);

    const reply = makeTestElement();
    reply.querySelectorAll = () => [];
    reply.matches = () => false;
    runtime.setCurrentReplyContext({
        identity: 'reply-1',
        chatIdentity: 'chat-1',
        reply,
        rect: {left: 420, right: 900, top: 100, bottom: 700, width: 480, height: 600},
        visibleTop: 80,
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    });
    runtime.updateReplyTopButton();
    const readyState = runtime.state();
    assert.equal(readyState.rootHidden, false);
    assert.equal(readyState.toolbarHidden, false);
    assert.equal(readyState.outlineHidden, false);
    assert.equal(readyState.toggleHidden, false);
    assert.equal(readyState.expanded, 'true');
});

test('pushed pinned outline holds its layout through same-chat message gaps', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    ui.toolbar.rect = {
        left: 292,
        right: 324,
        top: 299,
        bottom: 501,
        width: 32,
        height: 202
    };
    ui.outlineToggle.rect = {
        left: 292,
        right: 324,
        top: 235,
        bottom: 267,
        width: 32,
        height: 32
    };
    const setOutlineHeight = height => {
        ui.outline.rect = {
            left: 336,
            right: 636,
            top: 200,
            bottom: 200 + height,
            width: 300,
            height
        };
        ui.list.rect = {...ui.outline.rect, top: 247, height: height - 47};
    };
    setOutlineHeight(145);
    const layout = makeTestElement({
        rect: {left: 240, right: 1040, top: 0, bottom: 800, width: 800, height: 800}
    });
    layout.className = 'group/thread-scroll-layout';
    const reply = makeTestElement();
    layout.appendChild(reply);
    runtime.setContentLayouts([layout]);

    const makeContext = (target, identity) => ({
        identity,
        chatIdentity: 'chat-1',
        reply: target,
        rect: {left: 504, right: 900, top: 100, bottom: 700, width: 396, height: 600},
        visibleTop: 80,
        visibleBottom: 760,
        readingY: 300,
        viewport: {top: 0}
    });
    const firstContext = makeContext(reply, 'reply-1');
    runtime.install({
        ui,
        outlineOpen: true,
        currentReplyContext: firstContext
    });
    runtime.updateReplyNavigationControls(firstContext, []);
    assert.equal(ui.outline.style.top, '188px');
    runtime.advanceAnimation(50);
    runtime.advanceAnimation(50);
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '154px');

    runtime.setCurrentReplyContext(null);
    runtime.updateReplyTopButton();
    let state = runtime.state();
    assert.equal(state.rootHidden, false);
    assert.equal(state.toolbarHidden, false);
    assert.equal(state.outlineHidden, false);
    assert.equal(ui.outline.style.top, '188px');
    assert.equal(state.toggleHidden, false);
    assert.equal(state.expanded, 'true');
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '154px');
    assert.equal(runtime.pendingAnimations(), 0);

    const nextLayout = makeTestElement({
        rect: {left: 240, right: 1040, top: 0, bottom: 800, width: 800, height: 800}
    });
    nextLayout.className = 'group/thread-scroll-layout';
    const nextReply = makeTestElement();
    nextLayout.appendChild(nextReply);
    runtime.setContentLayouts([nextLayout]);
    const nextContext = makeContext(nextReply, 'reply-2');
    setOutlineHeight(560);
    runtime.setCurrentReplyContext(nextContext);
    runtime.updateReplyNavigationControls(nextContext, []);
    state = runtime.state();
    assert.equal(state.rootHidden, false);
    assert.equal(state.toolbarHidden, false);
    assert.equal(state.outlineHidden, false);
    assert.equal(ui.outline.style.top, '188px');
    assert.equal(ui.outline.style.maxHeight, '560px');
    assert.equal(layout.style.getPropertyValue('--thread-content-x'), '');
    assert.equal(nextLayout.style.getPropertyValue('--thread-content-x'), '154px');
    assert.equal(runtime.pendingAnimations(), 0);
    runtime.restoreContentShift();
});

test('runtime positions the six-control toolbar from the sidebar edge at window center', () => {
    const runtime = loadReplyNavigationRuntime();
    const ui = makeNavigationTestUI();
    const context = {
        identity: 'reply-1',
        reply: {isConnected: true},
        visibleTop: 200,
        rect: {left: 420},
        chatIdentity: 'chat-1'
    };
    runtime.install({
        ui,
        outlineOpen: false,
        currentReplyContext: context,
        sidebarGeometry: {left: 0, right: 280}
    });

    runtime.updateReplyNavigationControls(context, []);
    assert.equal(ui.toolbar.hidden, false);
    assert.equal(ui.toolbar.style.left, '292px');
    assert.equal(ui.toolbar.style.top, '299px');
    assert.equal(ui.outlineToggle.hidden, false);
    assert.equal(ui.outlineToggle.style.left, '292px');
    assert.equal(ui.outlineToggle.style.top, '235px');
    assert.equal(ui.outlineToggle.parentElement, ui.root);
    assert.equal(ui.toolbar.children.includes(ui.outlineToggle), false);
});

test('assistant reply target resolves from a search ID without a selection node', () => {
    const runtime = loadReplyNavigationRuntime();
    const messageId = 'assistant-dil-search-id';
    const assistantUnit = makeTestElement();
    assistantUnit.setAttribute('data-chatgpt-search-message-ids', messageId);
    const entry = {
        identity: `assistant:${messageId}`,
        kind: 'assistant',
        messageId,
        assistantMessageIds: [messageId],
        assistantUnit,
        root: assistantUnit
    };
    runtime.install({ui: makeNavigationTestUI(), turns: [entry]});

    assert.equal(assistantUnit.getAttribute('data-chatgpt-selection-message-id'), null);
    const resolved = runtime.resolveEntryTarget(entry, {replyTop: true});
    assert.equal(resolved.messageId, messageId);
    assert.equal(resolved.target, assistantUnit);
});

test('user navigation finds an ID-bearing user unit immediately without mounted turn references', () => {
    const runtime = loadReplyNavigationRuntime();
    const messageId = 'user-wrapper-message';
    const unit = makeMessageElement({
        'data-chatgpt-search-unit-key': 'fallback-turn-5:0:user',
        'data-chatgpt-search-message-ids': messageId
    });
    const innerUnit = unit.appendChild(makeMessageElement({
        'data-content-search-unit-key': 'fallback-turn-5:0:user'
    }));
    const bubble = innerUnit.appendChild(makeMessageElement({'data-user-message-bubble': 'true'}));
    const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: messageId};
    runtime.install({ui: makeNavigationTestUI(), turns: [entry]});
    runtime.setMessageElements([unit, innerUnit, bubble]);

    assert.equal(entry.root, undefined);
    assert.equal(bubble.getAttribute('data-chatgpt-search-message-ids'), null);
    assert.equal(runtime.resolveEntryTarget(entry, {replyTop: false}).target, bubble);
    assert.equal(runtime.resolveEntryTarget({
        ...entry, userMessageId: 'user-wrapper'
    }, {replyTop: false}).target, null);
});

test('user navigation retains legacy bubble IDs and keeps neighboring user units separate', () => {
    const runtime = loadReplyNavigationRuntime();
    const bubbles = [
        makeMessageElement({'data-user-message-bubble': 'true', 'data-message-id': 'legacy-message'}),
        makeMessageElement({'data-user-message-bubble': 'true', 'data-chatgpt-search-message-ids': 'legacy-search-message'})
    ];
    const unit = makeMessageElement({
        'data-content-search-unit-key': 'turn-2:user',
        'data-chatgpt-search-message-ids': 'wrapper-message'
    });
    const wrapperBubble = unit.appendChild(makeMessageElement({'data-user-message-bubble': 'true'}));
    runtime.install({ui: makeNavigationTestUI()});
    runtime.setMessageElements([...bubbles, unit, wrapperBubble]);

    for (const [messageId, expected] of [
        ['legacy-message', bubbles[0]],
        ['legacy-search-message', bubbles[1]],
        ['wrapper-message', wrapperBubble]
    ]) {
        const entry = {identity: `user:${messageId}`, kind: 'user', userMessageId: messageId};
        assert.equal(runtime.resolveEntryTarget(entry, {replyTop: false}).target, expected);
    }
});

test('reading anchors capture the same inner user bubble that restoration resolves', () => {
    const runtime = loadReplyNavigationRuntime();
    const messageId = 'user-anchor-message';
    const unit = makeMessageElement({
        'data-chatgpt-search-unit-key': 'fallback-turn-5:0:user',
        'data-chatgpt-search-message-ids': messageId
    });
    const bubble = unit.appendChild(makeMessageElement({'data-user-message-bubble': 'true'}));
    unit.rect = {top: 100, bottom: 200, left: 300, right: 700, width: 400, height: 100};
    bubble.rect = {...unit.rect, top: 152, height: 48};
    const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: messageId};
    runtime.install({ui: makeNavigationTestUI(), turns: [entry]});
    runtime.setMessageElements([unit, bubble]);

    const anchor = runtime.readingAnchor({scrollHeight: 1600, clientHeight: 800, scrollTop: 0});
    assert.equal(anchor.identity, entry.identity);
    assert.equal(anchor.messageId, messageId);
    assert.equal(anchor.offset, 152);
    assert.equal(runtime.readingAnchorTarget(anchor), bubble);
});

test('a settled foreground jump reacquires a recycled message once and resumes alignment', async () => {
    const runtime = loadReplyNavigationRuntime();
    runtime.install({ui: makeNavigationTestUI()});
    const messageId = 'recycled-user-message';
    const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: messageId};
    const oldTarget = makeMessageElement({'data-user-message-bubble': 'true'});
    oldTarget.isConnected = false;
    const unit = makeMessageElement({
        'data-chatgpt-search-unit-key': 'turn-5:user',
        'data-chatgpt-search-message-ids': messageId
    });
    const replacement = unit.appendChild(makeMessageElement({'data-user-message-bubble': 'true'}));
    let calls = 0;
    let finish;
    const locator = {locateMessage(id, isCurrent) {
        calls += 1;
        assert.equal(id, messageId);
        return new Promise(resolve => {
            finish = () => {
                assert.equal(isCurrent(), true);
                runtime.setMessageElements([unit, replacement]);
                resolve(true);
            };
        });
    }};
    const deadline = Date.now() + 15000;
    const search = runtime.beginForegroundSearch({entry, target: oldTarget, locator, deadline});
    runtime.correctForeground(search);
    runtime.correctForeground(search);
    runtime.correctForeground(search);
    const recovery = search.recoveryPromise;
    assert.equal(calls, 1);
    assert.equal(search.settled, false);
    finish();
    for (let frame = 0; frame < 12; frame += 1) {
        await Promise.resolve();
        runtime.advanceAnimation(16);
    }
    await recovery;

    assert.equal(search.target, replacement);
    assert.equal(search.settled, true);
    assert.equal(search.settleDeadline, deadline);
    assert.equal(runtime.currentForegroundSearch(), search);
    runtime.correctForeground(search);
    assert.equal(calls, 1);
});

test('foreground recovery can reacquire a second recycled node after the first handoff', async () => {
    const runtime = loadReplyNavigationRuntime();
    runtime.install({ui: makeNavigationTestUI()});
    const messageId = 'twice-recycled-message';
    const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: messageId};
    const oldTarget = makeMessageElement();
    oldTarget.isConnected = false;
    const replacements = [0, 1].map(() => {
        const unit = makeMessageElement({
            'data-chatgpt-search-unit-key': 'turn-5:user',
            'data-chatgpt-search-message-ids': messageId
        });
        const bubble = unit.appendChild(makeMessageElement({'data-user-message-bubble': 'true'}));
        return {unit, bubble};
    });
    const requests = [];
    const locator = {locateMessage(id, isCurrent) {
        assert.equal(id, messageId);
        return new Promise(resolve => requests.push(() => {
            assert.equal(isCurrent(), true);
            const {unit, bubble} = replacements[requests.length - 1];
            runtime.setMessageElements([unit, bubble]);
            resolve(true);
        }));
    }};
    const deadline = Date.now() + 15000;
    const search = runtime.beginForegroundSearch({entry, target: oldTarget, locator, deadline});
    runtime.correctForeground(search);
    const firstRecovery = search.recoveryPromise;
    requests[0]();
    for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
    assert.equal(search.target, replacements[0].bubble);
    assert.equal(search.settled, true);
    assert.equal(runtime.pendingAnimations(), 0);

    replacements[0].bubble.isConnected = false;
    runtime.setMessageElements([]);
    runtime.correctForeground(search);
    runtime.correctForeground(search);
    assert.equal(requests.length, 2);
    const secondRecovery = search.recoveryPromise;
    requests[1]();
    for (let frame = 0; frame < 12; frame += 1) {
        await Promise.resolve();
        runtime.advanceAnimation(16);
    }
    await Promise.all([firstRecovery, secondRecovery]);

    assert.equal(search.target, replacements[1].bubble);
    assert.equal(search.settled, true);
    assert.equal(search.settleDeadline, deadline);
    assert.equal(runtime.currentForegroundSearch(), search);
    assert.equal(requests.length, 2);
});

test('foreground recovery cannot scroll after a new jump, user input, route change or locator replacement', async () => {
    for (const cancellation of ['new-jump', 'user-input', 'route-change', 'locator-replacement']) {
        const runtime = loadReplyNavigationRuntime();
        runtime.install({ui: makeNavigationTestUI()});
        const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: 'message-5'};
        const oldTarget = makeMessageElement();
        oldTarget.isConnected = false;
        let finish;
        let lateScrolls = 0;
        const locator = {locateMessage(_id, isCurrent) {
            return new Promise(resolve => {
                finish = () => {
                    if (isCurrent()) lateScrolls += 1;
                    resolve(true);
                };
            });
        }};
        const search = runtime.beginForegroundSearch({entry, target: oldTarget, locator});
        runtime.correctForeground(search);
        const recovery = search.recoveryPromise;
        let newerSearch;
        if (cancellation === 'new-jump') {
            newerSearch = runtime.beginForegroundSearch({entry, target: oldTarget, locator});
        } else if (cancellation === 'user-input') {
            runtime.cancelForegroundForUserInput();
        } else if (cancellation === 'route-change') {
            runtime.setPathname('/c/another-chat');
        } else {
            runtime.replaceForegroundLocator({locateMessage: async () => false});
        }
        finish();
        await recovery;

        assert.equal(lateScrolls, 0, cancellation);
        assert.equal(search.cancelled, true, cancellation);
        assert.equal(runtime.currentForegroundSearch(), newerSearch || null, cancellation);
    }
});

test('failed native recovery and removed message membership stop further recovery attempts', async () => {
    for (const result of ['not-found', 'error', 'removed']) {
        const runtime = loadReplyNavigationRuntime();
        runtime.install({ui: makeNavigationTestUI()});
        const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: 'message-5'};
        const oldTarget = makeMessageElement();
        oldTarget.isConnected = false;
        let finish;
        let calls = 0;
        const locator = {locateMessage() {
            calls += 1;
            return new Promise((resolve, reject) => {
                finish = () => result === 'error'
                    ? reject(new Error('Native scroll failed'))
                    : resolve(result === 'removed');
            });
        }};
        const search = runtime.beginForegroundSearch({entry, target: oldTarget, locator});
        runtime.correctForeground(search);
        const recovery = search.recoveryPromise;
        if (result === 'removed') entry.userMessageId = 'replacement-message';
        finish();
        await recovery;
        runtime.correctForeground(search);

        assert.equal(calls, 1, result);
        assert.equal(search.cancelled, true, result);
        assert.equal(runtime.currentForegroundSearch(), null, result);
    }
});

test('foreground recovery ends when its original settle budget has expired', () => {
    const runtime = loadReplyNavigationRuntime();
    runtime.install({ui: makeNavigationTestUI()});
    const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: 'message-5'};
    const oldTarget = makeMessageElement();
    oldTarget.isConnected = false;
    let calls = 0;
    const locator = {locateMessage() { calls += 1; return true; }};
    const search = runtime.beginForegroundSearch({entry, target: oldTarget, locator, deadline: Date.now() - 1});
    runtime.correctForeground(search);

    assert.equal(calls, 0);
    assert.equal(search.cancelled, true);
    assert.equal(runtime.currentForegroundSearch(), null);
});

test('native-owned foreground correction observes the target without writing scroll state', () => {
    const runtime = loadReplyNavigationRuntime();
    const messageId = 'native-owned-message';
    const unit = makeMessageElement({
        'data-chatgpt-search-unit-key': 'turn-5:user',
        'data-chatgpt-search-message-ids': messageId
    });
    const bubble = unit.appendChild(makeMessageElement({
        'data-user-message-bubble': 'true'
    }));
    bubble.rect = {left: 300, right: 700, top: 60, bottom: 108, width: 400, height: 48};
    const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: messageId};
    runtime.install({ui: makeNavigationTestUI(), turns: [entry]});
    runtime.setMessageElements([unit, bubble]);
    const search = runtime.beginForegroundSearch({
        entry,
        target: bubble,
        locator: {locateMessage: async () => true},
        nativeScrollOwned: true
    });

    assert.equal(runtime.correctForeground(search), bubble);
    assert.equal(search.nativeScrollOwned, true);
    assert.equal(search.target, bubble);
    assert.equal(search.scrollContext.container.scrollTop, 0);
    assert.equal(search.scrollContext.container.style, undefined);
});

test('native-owned foreground alignment runs once after layout stabilizes and then stops recovery', async () => {
    const runtime = loadReplyNavigationRuntime();
    const messageId = 'native-aligned-message';
    const unit = makeMessageElement({
        'data-chatgpt-search-unit-key': 'turn-5:user',
        'data-chatgpt-search-message-ids': messageId
    });
    const bubble = unit.appendChild(makeMessageElement({
        'data-user-message-bubble': 'true'
    }));
    bubble.rect = {left: 300, right: 700, top: 60, bottom: 108, width: 400, height: 48};
    const entry = {identity: 'user:turn-5', kind: 'user', userMessageId: messageId};
    runtime.install({ui: makeNavigationTestUI(), turns: [entry]});
    runtime.setMessageElements([unit, bubble]);
    let nativeCalls = 0;
    const search = runtime.beginForegroundSearch({
        entry,
        target: bubble,
        locator: {locateMessage: async () => { nativeCalls += 1; return true; }},
        nativeScrollOwned: true
    });

    const settled = runtime.settleForeground(search);
    for (let frame = 0; frame < 12; frame += 1) {
        await Promise.resolve();
        runtime.advanceAnimation(16);
    }
    await settled;

    assert.equal(search.scrollContext.container.scrollTop, 60);
    assert.equal(search.nativeAlignmentComplete, true);
    assert.equal(search.settled, true);

    bubble.isConnected = false;
    runtime.setMessageElements([]);
    runtime.correctForeground(search);

    assert.equal(nativeCalls, 0);
    assert.equal(runtime.currentForegroundSearch(), null);
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

function loadReplyNavigationRuntime({localStorage, windowHeight = 800} = {}) {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const filename = require.resolve('./chatgpt-conversation-navigator.user.js');
    const source = fs.readFileSync(filename, 'utf8');
    const closureEnd = source.lastIndexOf('\n})();');
    assert.notEqual(closureEnd, -1, 'userscript IIFE end marker exists');
    const testState = {
        currentReplyContext: null,
        sidebarGeometry: null,
        contentLayouts: [],
        messageElements: [],
        jumpCalls: [],
        activeSearch: null,
        now: 0,
        nextFrameId: 1,
        rafQueue: new Map()
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
        querySelector() { return null; },
        querySelectorAll(selector) {
            return selector === '[class*="thread-scroll-layout"]'
                ? testState.contentLayouts
                : testState.messageElements.filter(element => element.matches(selector));
        },
        getElementById() { return null; },
        createElement() { return makeTestElement(); },
        createElementNS() { return makeTestElement(); }
    };
    const window = {
        innerWidth: 1200,
        innerHeight: windowHeight,
        location: {pathname: '/'},
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
            install({ui, outlineOpen,
                currentReplyContext = null, turns: testTurns = [],
                sidebarGeometry = null}) {
                initializeReplyOutlinePreferences();
                testState.preUIPreference = {
                    pinned: replyOutlinePinned,
                    open: replyOutlineOpen,
                    openPreference: replyOutlineOpenPreference
                };
                replyNavigationUI = ui;
                replyTopButton = {hidden: false, dataset: {}};
                if (typeof outlineOpen === 'boolean') replyOutlineOpen = outlineOpen;
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
            syncToggleBinding: syncReplyOutlineToggleBinding,
            setContentLayouts(layouts) {
                testState.contentLayouts = layouts;
            },
            setMessageElements(elements) { testState.messageElements = elements; },
            findContentLayout(context) {
                return getReplyThreadContentLayout(context);
            },
            applyContentShift(
                layout,
                shift,
                chatIdentity = 'chat-1',
                animate = false
            ) {
                applyReplyOutlineContentShift(
                    layout,
                    shift,
                    chatIdentity,
                    animate
                );
            },
            restoreContentShift: restoreReplyOutlineContentShift,
            extendScrollRange: extendScrollRangeTo,
            clearScrollRange: clearExtendedScrollRange,
            advanceAnimation(ms) {
                testState.now += Number(ms) || 0;
                const callbacks = Array.from(testState.rafQueue.values());
                testState.rafQueue.clear();
                for (const callback of callbacks) callback(testState.now);
            },
            pendingAnimations() {
                return testState.rafQueue.size;
            },
            contentShiftState() {
                if (!replyOutlineContentShiftState) return null;
                return {
                    element: replyOutlineContentShiftState.element,
                    chatIdentity: replyOutlineContentShiftState.chatIdentity,
                    baseValue: replyOutlineContentShiftState.baseValue,
                    appliedPixels: replyOutlineContentShiftState.appliedPixels,
                    appliedValue: replyOutlineContentShiftState.appliedValue
                };
            },
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
            getReplyHeadingEntries,
            setReplyOutlineOpen,
            click(target) { return document.dispatchClick(target); },
            initializeSettings: initializeReplyOutlinePreferences,
            preUIPreference() { return testState.preUIPreference; },
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
            setCurrentChatIdentity(identity) { currentChatIdentity = identity; },
            currentChatIdentity() { return currentChatIdentity; },
            setPathname(pathname) { window.location.pathname = pathname; },
            setNewConversationSubmissionPending(value) {
                newConversationSubmissionPending = Boolean(value);
            },
            stubRouteNativeStartup() {
                startNativeLocator = () => {};
                startNativeAdapter = () => {};
            },
            handleRouteChange,
            replyNavigationContext() { return replyNavigationContext; },
            clearPendingAssistantNavigation() {
                assistantReplyNavigationCursor = null;
            },
            jumpCalls() { return testState.jumpCalls; },
            navigateAssistantReply,
            resolveEntryTarget(entry, options = {replyTop: true}) {
                const messageId = getEntryTargetMessageId(entry, options);
                return {
                    messageId,
                    target: findMountedMessageForEntry(entry, messageId)
                };
            },
            readingAnchor(scrollContainer) {
                document.scrollingElement = scrollContainer;
                return getVisibleReadingAnchor();
            },
            readingAnchorTarget: findReadingAnchorTarget,
            beginForegroundSearch({
                entry,
                target,
                locator,
                deadline = Date.now() + 15000,
                nativeScrollOwned = false
            }) {
                cancelJumpSearch();
                currentChatIdentity = 'conversation:chat';
                window.location.pathname = '/c/chat';
                turns = [entry];
                nativeLocator = locator;
                nativeLocatorEpoch += 1;
                document.scrollingElement = {scrollHeight: 1600, clientHeight: 800, scrollTop: 0};
                window.scrollY = 0;
                window.scrollTo = (_left, top) => { window.scrollY = top; };
                activeJumpSearch = {
                    identity: entry.identity,
                    messageId: entry.userMessageId,
                    chatIdentity: currentChatIdentity,
                    options: {},
                    userScrollGeneration,
                    settled: true,
                    cancelled: false,
                    correctionFrame: null,
                    target,
                    settleDeadline: deadline,
                    nativeScrollOwned
                };
                return activeJumpSearch;
            },
            correctForeground: correctForegroundTarget,
            settleForeground: waitForForegroundSettle,
            currentForegroundSearch() { return activeJumpSearch; },
            cancelForegroundForUserInput() {
                userScrollGeneration += 1;
                cancelJumpSearch();
            },
            replaceForegroundLocator(locator) {
                nativeLocator = locator;
                nativeLocatorEpoch += 1;
            },
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
                    pinned: replyOutlinePinned,
                    openPreference: replyOutlineOpenPreference
                };
            }
        };
    `;
    const context = {
        __replyTestState: testState,
        document,
        window,
        console,
        performance: {now: () => testState.now},
        requestAnimationFrame(callback) {
            const id = testState.nextFrameId++;
            testState.rafQueue.set(id, callback);
            return id;
        },
        cancelAnimationFrame(id) {
            testState.rafQueue.delete(id);
        },
        // Projection scheduling is exercised with a clock in navigation-updates.test.cjs.
        setTimeout() { return 1; },
        clearTimeout() {}
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
    root.appendChild(toolbar);
    root.appendChild(outlineToggle);
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

function makeReplyHeadingRoot(specs) {
    const reply = makeTestElement();
    reply.tagName = 'DIV';
    reply.matches = selector => matchesTestHeadingSelector(reply, selector);
    reply.querySelectorAll = selector => {
        const matches = [];
        const visit = parent => {
            for (const child of parent.children) {
                if (matchesTestHeadingSelector(child, selector)) matches.push(child);
                visit(child);
            }
        };
        visit(reply);
        return matches;
    };

    const makeNode = spec => {
        const element = makeTestElement({
            rect: {left: 300, right: 700, top: 100, bottom: 124, width: 400, height: 24}
        });
        element.tagName = spec.tagName;
        element.className = spec.className;
        element.textContent = spec.text || '';
        if (spec.dataComponent) {
            element.setAttribute('data-d-component', spec.dataComponent);
        }
        element.matches = selector =>
            matchesTestHeadingSelector(element, selector) ||
            matchesTestBoxContainerSelector(element, selector);
        element.closest = selector => {
            for (let current = element; current; current = current.parentElement) {
                if (current.matches?.(selector)) return current;
            }
            return null;
        };
        for (const child of spec.children || []) {
            element.appendChild(makeNode(child));
        }
        return element;
    };

    for (const spec of specs) reply.appendChild(makeNode(spec));
    return reply;
}

function summarizeReplyHeadingEntries(runtime, reply) {
    return JSON.parse(JSON.stringify(
        runtime.getReplyHeadingEntries({reply}).map(({text, level}) => ({text, level}))
    ));
}

function matchesTestHeadingSelector(element, selector) {
    const className = String(element.className || '');
    return selector.split(',').some(part => {
        const trimmed = part.trim();
        const classMatch = trimmed.match(/^(h[1-6])\.([\w-]+)$/i);
        if (classMatch && element.tagName?.toLowerCase() === classMatch[1].toLowerCase()) {
            return className.split(/\s+/).includes(classMatch[2]);
        }
        const componentMatch = trimmed.match(/^(h[1-6])\[data-d-component="title"\]$/i);
        return componentMatch && element.tagName?.toLowerCase() === componentMatch[1].toLowerCase() &&
            element.getAttribute('data-d-component') === 'title';
    });
}

function matchesTestBoxContainerSelector(element, selector) {
    return selector === '[data-d-component="box"]' &&
        element.getAttribute('data-d-component') === 'box';
}

function makeMessageElement(attributes = {}) {
    const element = makeTestElement();
    for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
    element.hasAttribute = name => element.getAttribute(name) !== null;
    element.matches = selector => selector.split(',').some(part => {
        const checks = Array.from(part.trim().matchAll(/\[([\w-]+)(?:([*$]?=)"([^"]*)")?\]/g));
        return checks.length > 0 && checks.every(([, name, operator, expected]) => {
            const value = element.getAttribute(name);
            if (!operator) return value !== null;
            if (value === null) return false;
            if (operator === '$=') return value.endsWith(expected);
            if (operator === '*=') return value.includes(expected);
            return value === expected;
        });
    });
    element.closest = selector => {
        for (let node = element; node; node = node.parentElement) {
            if (node.matches(selector)) return node;
        }
        return null;
    };
    element.querySelectorAll = selector => element.children.flatMap(child => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector)
    ]);
    element.querySelector = selector => element.querySelectorAll(selector)[0] || null;
    return element;
}

function makeScrollRangeTestContext(originalValue, originalPriority) {
    const container = makeTestElement();
    let value = originalValue;
    let priority = originalPriority;
    container.style = {
        get paddingBottom() { return value || '0px'; },
        getPropertyValue() { return value; },
        getPropertyPriority() { return priority; },
        setProperty(_name, nextValue, nextPriority = '') {
            value = nextValue;
            priority = nextPriority;
        },
        removeProperty() { value = ''; priority = ''; }
    };
    return {container, maxTop: () => 90 + (parseFloat(value) || 0)};
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
        classList: {
            add(...tokens) {
                const classes = new Set(String(element.className || '').split(/\s+/).filter(Boolean));
                for (const token of tokens) classes.add(token);
                element.className = Array.from(classes).join(' ');
            },
            remove(...tokens) {
                const removed = new Set(tokens);
                element.className = String(element.className || '').split(/\s+/)
                    .filter(token => token && !removed.has(token)).join(' ');
            },
            contains(token) {
                return String(element.className || '').split(/\s+/).includes(token);
            },
            toggle(token, force) {
                const enabled = force === undefined ? !this.contains(token) : Boolean(force);
                if (enabled) this.add(token);
                else this.remove(token);
                return enabled;
            }
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
