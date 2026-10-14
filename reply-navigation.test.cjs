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
    computeReplyToolbarPosition
} = require('./chatgpt-conversation-navigator.user.js');

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

test('toolbar anchors beside a visible sidebar and follows resizing', () => {
    const position = computeReplyToolbarPosition({
        viewportLeft: 0,
        viewportRight: 1739,
        contentLeft: 482,
        sidebarLeft: 0,
        sidebarRight: 343,
        sidebarVisible: true,
        viewportTop: 800,
        viewportBottom: 900,
        windowHeight: 1244,
        headerInset: 40,
        bottomInset: 20,
        toolbarWidth: 32,
        toolbarHeight: 168,
        centerRatio: 0.7
    });

    assert.deepEqual(position, {left: 355, top: 538});
    assert.equal(computeReplyToolbarPosition({
        viewportLeft: 0,
        viewportRight: 1739,
        contentLeft: 482,
        sidebarLeft: 0,
        sidebarRight: 400,
        sidebarVisible: true,
        viewportTop: 50,
        viewportBottom: 1244,
        toolbarHeight: 168
    }).left, 412);
});

test('toolbar follows the visible sidebar even when it ends before the scroll viewport', () => {
    const positionForSidebarRight = sidebarRight => computeReplyToolbarPosition({
        viewportLeft: 360,
        viewportRight: 1739,
        windowWidth: 1739,
        contentLeft: 482,
        sidebarLeft: 0,
        sidebarRight,
        sidebarVisible: true,
        viewportTop: 0,
        viewportBottom: 1244,
        windowHeight: 1244
    });

    assert.equal(positionForSidebarRight(343).left, 355);
    assert.equal(positionForSidebarRight(300).left, 312);
    assert.equal(computeReplyToolbarPosition({
        viewportLeft: 48,
        viewportRight: 1200,
        windowWidth: 1200,
        contentLeft: 180,
        sidebarLeft: 0,
        sidebarRight: 40,
        sidebarVisible: true,
        viewportTop: 0,
        viewportBottom: 900,
        windowHeight: 900
    }).left, 52);
    assert.equal(computeReplyToolbarPosition({
        viewportLeft: 360,
        viewportRight: 1739,
        windowWidth: 1739,
        contentLeft: 482,
        sidebarLeft: 0,
        sidebarRight: 343,
        sidebarVisible: false,
        viewportTop: 0,
        viewportBottom: 1244,
        windowHeight: 1244
    }).left, 372);
});

test('toolbar centers in the physical window even when a nested reading viewport is short', () => {
    const position = computeReplyToolbarPosition({
        viewportLeft: 0,
        viewportRight: 1200,
        contentLeft: 200,
        viewportTop: 600,
        viewportBottom: 700,
        headerInset: 60,
        bottomInset: 60,
        windowHeight: 1244,
        toolbarHeight: 168
    });

    assert.deepEqual(position, {left: 12, top: 538});
    assert.equal(computeReplyToolbarPosition({
        viewportLeft: 0,
        viewportRight: 1200,
        contentLeft: 200,
        viewportTop: 0,
        viewportBottom: 160,
        windowHeight: 160,
        toolbarHeight: 168
    }), null);
});

test('collapsed sidebar falls back to the viewport edge and toolbar hides without a safe gutter', () => {
    const fallback = computeReplyToolbarPosition({
        viewportLeft: 40,
        viewportRight: 1280,
        contentLeft: 180,
        sidebarLeft: 0,
        sidebarRight: 56,
        sidebarVisible: false,
        viewportTop: 80,
        viewportBottom: 900
    });

    assert.equal(fallback.left, 52);
    assert.equal(computeReplyToolbarPosition({
        viewportLeft: 0,
        viewportRight: 1280,
        contentLeft: 40,
        sidebarLeft: 0,
        sidebarRight: 24,
        sidebarVisible: false,
        viewportTop: 80,
        viewportBottom: 900
    }), null);
    assert.equal(computeReplyToolbarPosition({
        viewportLeft: 250,
        viewportRight: 1280,
        contentLeft: 290,
        viewportTop: 80,
        viewportBottom: 900
    }), null);
});
