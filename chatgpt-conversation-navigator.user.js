// ==UserScript==
// @name         ChatGPT Conversation Navigator
// @namespace    https://github.com/Fucose
// @version      0.3.7
// @description  ChatGPT 对话导航：悬停预览，点击跳转。
// @author       Fucose
// @homepageURL  https://gist.github.com/Fucose/fc9f1963666d75e7f93a5edceae137c7
// @supportURL   https://gist.github.com/Fucose/fc9f1963666d75e7f93a5edceae137c7#comments
// @updateURL    https://gist.githubusercontent.com/Fucose/fc9f1963666d75e7f93a5edceae137c7/raw/chatgpt-conversation-navigator.user.js
// @downloadURL  https://gist.githubusercontent.com/Fucose/fc9f1963666d75e7f93a5edceae137c7/raw/chatgpt-conversation-navigator.user.js
// @match        https://chatgpt.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const RAIL_ID = 'yw-chatgpt-turn-rail';
    const PREVIEW_ID = 'yw-chatgpt-turn-preview';
    const STYLE_ID = 'yw-chatgpt-turn-nav-style';
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
    let preview = null;
    let previewUser = null;
    let previewAssistant = null;

    let turns = [];
    let turnSignature = '';
    let activeIndex = -1;
    let turnRecordsByChat = new Map();
    let activeJumpSearch = null;

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
    let extendedScrollRange = null;
    let assistantLabelRefreshTimer = null;
    let pendingAssistantLabelUnits = new Map();

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

                width: 44px;
                max-height: 72vh;
                --yw-nav-hit-width: 44px;

                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: var(--yw-nav-gap, 8px);

                overflow-y: auto;
                overflow-x: visible;

                padding: 8px 2px 8px 8px;
                margin: 0;

                z-index: 2147483646;

                scrollbar-width: none;
                pointer-events: auto;
            }

            #${RAIL_ID}::-webkit-scrollbar {
                display: none;
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

                background: rgba(120, 120, 120, 0.34);
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
                    width: 38px;
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

    function ensureUI() {
        installStyles();

        rail = document.getElementById(RAIL_ID);

        if (!rail) {
            rail = document.createElement('div');
            rail.id = RAIL_ID;
            rail.setAttribute('aria-label', 'ChatGPT conversation navigator');

            document.body.appendChild(rail);
        }

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
    }

    function clearNavigation() {
        cancelJumpSearch();
        clearExtendedScrollRange();

        turns = [];
        turnSignature = '';
        activeIndex = -1;

        if (activeRAF !== null) {
            cancelAnimationFrame(activeRAF);
            activeRAF = null;
        }

        if (rail) {
            rail.replaceChildren();
            rail.style.display = 'none';
            rail.scrollTop = 0;
        }

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

        /* 根页刚提交 composer 后生成的 /c/<id> 才保留当前新对话。 */
        if (
            newConversationSubmissionPending &&
            isConversationUrlPromotion(currentChatIdentity, identity)
        ) {
            transferChatTurnIdentities(currentChatIdentity, identity);
            currentChatIdentity = identity;
            clearNewConversationSubmission();
            return;
        }

        clearNewConversationSubmission();
        currentChatIdentity = identity;

        if (rebuildTimer !== null) {
            clearTimeout(rebuildTimer);
            rebuildTimer = null;
        }

        clearNavigation();
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

    function getTurnRecordStore(chatIdentity) {
        if (!turnRecordsByChat.has(chatIdentity)) {
            turnRecordsByChat.set(chatIdentity, {
                turns: [],
                byIdentity: new Map(),
                pairedAssistantToUser: new Map(),
                suppressedRemovedIdentities: new Map()
            });
        }

        return turnRecordsByChat.get(chatIdentity);
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
        let positionIndex = upperBound;
        if (Number.isFinite(record.orderPosition)) {
            const positionedIndex = records.findIndex(existing =>
                Number.isFinite(existing.orderPosition) &&
                existing.orderPosition > record.orderPosition
            );
            if (
                positionedIndex >= 0 ||
                (previousAnchorIndex < 0 && nextAnchorIndex < 0)
            ) {
                positionIndex = positionedIndex >= 0
                    ? positionedIndex
                    : records.length;
            }
        }

        const insertionIndex = Math.max(
            lowerBound,
            Math.min(upperBound, positionIndex)
        );
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

        const location = getTurnScrollLocation(record.root);
        if (location) {
            record.lastScrollTop = location.scrollTop;
            record.scrollIsDocument = location.isDocumentScroll;
            record.orderPosition = location.orderPosition;
        }
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
                baselineText: record.userTextSnapshot || getFullUserText(turn),
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

        for (const turn of observed) {
            if (turn.kind !== 'user' || !turn.stableIdentity) continue;
            const record = store.byIdentity.get(turn.identity);
            if (!record || typeof record.userTextSnapshot !== 'string') continue;

            if (
                getFullUserText(turn) !== record.userTextSnapshot &&
                getInlineUserEditors(turn.root).length === 0
            ) {
                return reconcileEditedBranch(
                    store,
                    turn.identity,
                    true,
                    observed
                );
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
                    assistantText: '',
                    lastScrollTop: null,
                    scrollIsDocument: null,
                    orderPosition: null
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
    }

    function buildRenderedTurns(observedTurns) {
        const store = getTurnRecordStore(currentChatIdentity);
        const rendered = store.turns.slice();
        const placements = [];

        if (!store.turns.length) {
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

        /* 末尾消息的滚动范围不足时，临时增加底部 padding 以允许顶部对齐。 */
        const originalValue = container.style.getPropertyValue('padding-bottom');
        const originalPriority = container.style.getPropertyPriority('padding-bottom');
        const computedPadding = parseFloat(
            window.getComputedStyle(container).paddingBottom
        ) || 0;
        let appliedPadding = computedPadding + desiredTop - maxScrollTop + 2;

        container.style.setProperty(
            'padding-bottom',
            `${appliedPadding}px`,
            'important'
        );

        let extendedMaxScrollTop = scrollContext.maxTop();

        if (extendedMaxScrollTop < desiredTop) {
            appliedPadding += desiredTop - extendedMaxScrollTop + 2;
            container.style.setProperty(
                'padding-bottom',
                `${appliedPadding}px`,
                'important'
            );
            extendedMaxScrollTop = scrollContext.maxTop();
        }

        const appliedValue = `${appliedPadding}px`;
        extendedScrollRange = {
            container,
            originalValue,
            originalPriority,
            appliedValue
        };

        return extendedMaxScrollTop;
    }

    function observeUserScrollIntent() {
        for (const eventName of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
            const target = eventName === 'keydown' ? window : document;
            target.addEventListener(eventName, () => {
                cancelJumpSearch();
                clearExtendedScrollRange();
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
            const canScroll = /^(auto|scroll|overlay|hidden)$/.test(
                style.overflowY
            );

            if (canScroll && ancestor.clientHeight > 0) {
                return ancestor;
            }
        }

        return document.scrollingElement || document.documentElement;
    }

    function getTurnScrollLocation(target) {
        if (!target?.isConnected) return null;

        const scrollContext = createScrollContext(target);
        const viewportTop = scrollContext.viewportTop;
        const scrollTop = scrollContext.getTop();

        return {
            scrollTop,
            isDocumentScroll: scrollContext.isDocumentScroll,
            orderPosition: scrollTop +
                target.getBoundingClientRect().top - viewportTop
        };
    }

    function cancelJumpSearch() {
        if (activeJumpSearch) {
            activeJumpSearch.cancelled = true;
            activeJumpSearch = null;
        }
    }

    function isCurrentJumpSearch(search) {
        return Boolean(
            search &&
            activeJumpSearch === search &&
            !search.cancelled &&
            currentChatIdentity === search.chatIdentity &&
            getChatIdentity() === search.chatIdentity
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
                const boundedTop = Math.max(
                    0,
                    Math.min(currentMaxTop, value)
                );
                const rawTop = isReverseFlexScroll
                    ? boundedTop - currentMaxTop
                    : boundedTop;
                setScrollTop(container, isDocumentScroll, rawTop);
                return boundedTop;
            },
            maxTop
        };
    }

    function findMountedTurn(
        identity,
        chatIdentity,
        observedTurns = null,
        discardPairSnapshot = false
    ) {
        if (
            currentChatIdentity !== chatIdentity ||
            getChatIdentity() !== chatIdentity
        ) {
            return null;
        }

        const mounted = (observedTurns || collectTurns()).find(turn =>
            turn.identity === identity &&
            turn.root?.isConnected &&
            trackCurrentRouteTurn(turn)
        ) || null;
        if (mounted && discardPairSnapshot) {
            delete mounted.pairedAssistantUnits;
            delete mounted.pairedAssistantIdentities;
        }
        return mounted;
    }

    function findMountedStableTurn(
        identity,
        chatIdentity,
        observedTurns = null,
        discardPairSnapshot = false
    ) {
        const turn = findMountedTurn(
            identity,
            chatIdentity,
            observedTurns,
            discardPairSnapshot
        );
        return turn?.stableIdentity ? turn : null;
    }

    async function waitForBoundarySettle(
        scrollContext,
        identity,
        search,
        previousTop,
        previousMaxScrollTop,
        searchDeadline
    ) {
        const deadline = Math.min(Date.now() + 2000, searchDeadline);
        const initialVisibleTurns = collectTurns()
            .filter(turn => turn.stableIdentity)
            .map(turn => turn.identity)
            .join('|');

        while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
            if (!isCurrentJumpSearch(search)) return { cancelled: true };

            const currentTurns = collectTurns();
            const mounted = findMountedStableTurn(
                identity,
                search.chatIdentity,
                currentTurns,
                true
            );
            if (mounted) return { mounted };

            const currentTop = scrollContext.getTop();
            const currentMaxScrollTop = scrollContext.maxTop();
            const currentVisibleTurns = currentTurns
                .filter(turn => turn.stableIdentity)
                .map(turn => turn.identity)
                .join('|');
            if (
                currentTop !== previousTop ||
                currentMaxScrollTop !== previousMaxScrollTop ||
                currentVisibleTurns !== initialVisibleTurns
            ) {
                return { changed: true };
            }
        }

        return { changed: false };
    }

    async function searchForTurn(record, search) {
        const chatStore = turnRecordsByChat.get(search.chatIdentity);
        const currentMountedTurn = collectTurns().find(turn =>
            turn.root?.isConnected && trackCurrentRouteTurn(turn)
        );
        const scrollTarget = currentMountedTurn?.root;
        if (!scrollTarget) return null;

        const scrollContext = createScrollContext(scrollTarget);
        const { container, isDocumentScroll } = scrollContext;
        const step = Math.max(
            240,
            Math.floor((container.clientHeight || window.innerHeight) * 0.7)
        );
        const hasCompatibleLocation =
            record.scrollIsDocument === isDocumentScroll;

        clearExtendedScrollRange();

        const cachedTop = record.lastScrollTop;
        if (hasCompatibleLocation && Number.isFinite(cachedTop)) {
            scrollContext.setTop(cachedTop);
        }

        await waitForAnimationFrame();
        await waitForAnimationFrame();
        if (!isCurrentJumpSearch(search)) return null;

        let mounted = findMountedStableTurn(
            record.identity,
            search.chatIdentity,
            null,
            true
        );
        if (mounted) return mounted;

        let direction = 1;
        if (
            hasCompatibleLocation &&
            Number.isFinite(record.orderPosition)
        ) {
            const top = scrollContext.getTop();
            const viewportMiddle = top +
                (container.clientHeight || window.innerHeight) / 2;
            direction = record.orderPosition < viewportMiddle ? -1 : 1;
        } else if (chatStore) {
            const targetIndex = chatStore.turns.findIndex(turn =>
                turn.identity === record.identity
            );
            const visibleIndex = chatStore.turns.findIndex(turn =>
                turn.identity === currentMountedTurn.identity
            );
            if (targetIndex >= 0 && visibleIndex >= 0) {
                direction = targetIndex < visibleIndex ? -1 : 1;
            }
        }

        const maxSteps = 240;
        const startedAt = Date.now();
        let reversed = false;

        for (let attempt = 0; attempt < maxSteps; attempt++) {
            if (
                !isCurrentJumpSearch(search) ||
                Date.now() - startedAt > 12000
            ) {
                return null;
            }

            const before = scrollContext.getTop();
            const maxBefore = scrollContext.maxTop();
            scrollContext.setTop(before + direction * step);
            const after = scrollContext.getTop();

            if (after === before) {
                const boundary = await waitForBoundarySettle(
                    scrollContext,
                    record.identity,
                    search,
                    before,
                    maxBefore,
                    startedAt + 12000
                );
                if (boundary.cancelled) return null;
                if (boundary.mounted) return boundary.mounted;
                if (boundary.changed) continue;
                if (reversed) return null;
                direction *= -1;
                reversed = true;
                continue;
            }

            await waitForAnimationFrame();
            await waitForAnimationFrame();
            if (!isCurrentJumpSearch(search)) return null;

            mounted = findMountedStableTurn(
                record.identity,
                search.chatIdentity,
                null,
                true
            );
            if (mounted) return mounted;
        }

        return null;
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

    function scrollTurnMessageToTop(target, index) {
        if (!target?.isConnected) return false;

        clearExtendedScrollRange();

        const scrollContext = createScrollContext(target);
        const viewportTop = scrollContext.viewportTop;
        const scrollTop = scrollContext.getTop();
        const headerInset = getFixedHeaderInset(
            target,
            scrollContext
        );

        /* 最后一轮可能没有足够的末尾空间供浏览器将其顶端对齐。 */
        if (index === turns.length - 1) {
            const desiredTop = Math.max(
                0,
                target.getBoundingClientRect().top - viewportTop + scrollTop -
                    headerInset
            );
            extendScrollRangeTo(scrollContext, desiredTop);
        }

        /* 让浏览器处理真实的滚动祖先链，避免手算后滚错容器。 */
        const originalMargin = target.style.getPropertyValue('scroll-margin-top');
        const originalPriority = target.style.getPropertyPriority('scroll-margin-top');
        if (headerInset > 0) {
            const existingMargin = parseFloat(
                window.getComputedStyle(target).scrollMarginTop
            ) || 0;
            target.style.setProperty(
                'scroll-margin-top',
                `${existingMargin + headerInset}px`,
                'important'
            );
        }

        try {
            target.scrollIntoView({
                behavior: 'smooth',
                block: 'start',
                inline: 'nearest'
            });
        } finally {
            if (headerInset > 0) {
                if (originalMargin) {
                    target.style.setProperty(
                        'scroll-margin-top',
                        originalMargin,
                        originalPriority
                    );
                } else {
                    target.style.removeProperty('scroll-margin-top');
                }
            }
        }

        return true;
    }

    async function jumpToTurn(index) {
        const selectedTurn = turns[index];
        if (!selectedTurn) return;

        const chatIdentity = currentChatIdentity;
        const identity = selectedTurn.identity;
        const stableIdentity = selectedTurn.stableIdentity;
        const store = turnRecordsByChat.get(chatIdentity);
        const record = store?.byIdentity.get(identity) || selectedTurn;

        cancelJumpSearch();
        const search = { chatIdentity, identity, cancelled: false };
        activeJumpSearch = search;

        try {
            let mounted = findMountedTurn(identity, chatIdentity);

            if (!mounted && !stableIdentity) {
                /* Fallback text/index identities cannot safely locate an unmounted node. */
                return;
            }

            if (
                !stableIdentity &&
                (mounted?.root !== selectedTurn.root ||
                    mounted?.userBubble !== selectedTurn.userBubble)
            ) {
                return;
            }

            if (!mounted && stableIdentity) {
                mounted = await searchForTurn(record, search);
            }

            if (!mounted || !isCurrentJumpSearch(search)) return;

            mergeObservedTurnRecords([mounted], false);
            renderTurns();

            /* Reconfirm the exact identity after any virtualizer remount. */
            const verified = findMountedTurn(identity, chatIdentity);
            if (!verified?.root?.isConnected) return;
            if (
                !stableIdentity &&
                (verified.root !== selectedTurn.root ||
                    verified.userBubble !== selectedTurn.userBubble)
            ) {
                return;
            }

            const verifiedRecord = turnRecordsByChat
                .get(chatIdentity)?.byIdentity.get(identity);
            const target = verified.userBubble?.isConnected
                ? verified.userBubble
                : verified.root;
            const currentIndex = turns.findIndex(turn =>
                turn.identity === identity
            );

            if (
                currentIndex < 0 ||
                (stableIdentity && !verifiedRecord) ||
                !target?.isConnected ||
                !scrollTurnMessageToTop(target, currentIndex)
            ) {
                return;
            }

            setActive(currentIndex);
        } finally {
            if (activeJumpSearch === search) activeJumpSearch = null;
        }
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

    function updateRailDensity() {
        if (!rail) return;

        const count = turns.length;

        if (!count) return;

        const available = Math.max(
            180,
            Math.floor(window.innerHeight * 0.72)
        );

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

        rail.style.setProperty(
            '--yw-nav-bar-height',
            `${snapSize(barHeight)}px`
        );

        rail.style.setProperty(
            '--yw-nav-gap',
            `${snapSize(gap)}px`
        );

        rail.style.maxHeight = `${available}px`;

        /*
         * 页面缩放及容器居中会让横条落在小数物理像素上，造成粗细交替。
         * 批量读取位置后再写入偏移，避免反复布局；扣除旧偏移防止累积。
         */
        const offsets = Array.from(rail.children, bar => {
            const previousOffset = parseFloat(
                bar.style.getPropertyValue('--yw-nav-bar-offset')
            ) || 0;
            const top = bar.getBoundingClientRect().top - previousOffset;

            return Math.round(top * pixelRatio) / pixelRatio - top;
        });

        offsets.forEach((offset, index) => {
            rail.children[index].style.setProperty(
                '--yw-nav-bar-offset',
                `${offset}px`
            );
        });
    }


    /******************************************************************
     * Render bars
     ******************************************************************/

    function renderTurns() {
        handleRouteChange();
        ensureUI();

        const observedTurns = collectTurns().filter(trackCurrentRouteTurn);
        mergeObservedTurnRecords(observedTurns, true, true, true);
        const newTurns = buildRenderedTurns(observedTurns);
        const labelSources = new Map(observedTurns.map(turn => [
            turn.identity,
            turn
        ]));

        const newSignature = newTurns
            .map(turn => turn.identity)
            .join('|');

        /*
         * key 顺序没变时不重建 DOM，
         * 但仍然更新 root 引用。
         *
         * ChatGPT virtualization 有可能重新创建节点。
         */
        if (
            newSignature === turnSignature &&
            newTurns.length === turns.length &&
            rail.children.length === newTurns.length
        ) {
            turns = newTurns;
            updateRailDensity();

            newTurns.forEach((turn, index) => {
                rail.children[index]?.setAttribute(
                    'aria-label',
                    getTurnBarLabel(
                        turn,
                        index,
                        labelSources.get(turn.identity) || turn
                    )
                );
            });

            if (newTurns.length === 0) {
                rail.style.display = 'none';
                preview.classList.remove('yw-visible');
            }

            scheduleActiveUpdate();
            return;
        }

        turns = newTurns;
        turnSignature = newSignature;
        activeIndex = -1;

        rail.replaceChildren();

        if (turns.length === 0) {
            rail.style.display = 'none';
            preview.classList.remove('yw-visible');
            return;
        }

        rail.style.display = 'flex';

        turns.forEach((turn, index) => {
            const bar = document.createElement('button');

            bar.type = 'button';
            bar.className = 'yw-turn-bar';

            bar.setAttribute(
                'aria-label',
                getTurnBarLabel(
                    turn,
                    index,
                    labelSources.get(turn.identity) || turn
                )
            );

            /*
             * 使用 index 而不是把 turn 对象锁死在 closure 中。
             * 这样 virtualization 替换 DOM 节点后仍然使用最新 turns[]。
             */
            bar.addEventListener('mouseenter', () => {
                showPreview(index, bar);
            });

            bar.addEventListener('mouseleave', () => {
                hidePreviewSoon();
            });

            bar.addEventListener('focus', () => {
                showPreview(index, bar);
            });

            bar.addEventListener('blur', () => {
                hidePreviewSoon();
            });

            bar.addEventListener('click', event => {
                event.preventDefault();
                event.stopPropagation();

                jumpToTurn(index);
            });

            rail.appendChild(bar);
        });

        updateRailDensity();
        scheduleActiveUpdate();
    }


    /******************************************************************
     * 当前阅读位置
     ******************************************************************/

    function setActive(index) {
        if (!rail) return;
        if (index === activeIndex) return;

        if (
            activeIndex >= 0 &&
            rail.children[activeIndex]
        ) {
            rail.children[activeIndex]
                .classList.remove('yw-active');

            rail.children[activeIndex]
                .removeAttribute('aria-current');
        }

        activeIndex = index;

        if (
            activeIndex >= 0 &&
            rail.children[activeIndex]
        ) {
            const bar = rail.children[activeIndex];

            bar.classList.add('yw-active');
            bar.setAttribute('aria-current', 'true');

            keepActiveBarVisible(bar);
        }
    }

    function keepActiveBarVisible(bar) {
        if (!rail || !bar) return;

        const top = bar.offsetTop;
        const bottom = top + bar.offsetHeight;

        const visibleTop = rail.scrollTop;
        const visibleBottom =
            rail.scrollTop + rail.clientHeight;

        if (top < visibleTop) {
            rail.scrollTop =
                Math.max(0, top - rail.clientHeight * 0.25);
        } else if (bottom > visibleBottom) {
            rail.scrollTop =
                bottom - rail.clientHeight * 0.75;
        }
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
            const root = turns[i].root;

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
        }, 180);
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

                rail?.children[index]?.setAttribute(
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
                    preview?.contains(mutation.target)
                ) {
                    continue;
                }

                captureUserEditCandidatesFromMutation(mutation);

                if (mutation.type === 'characterData') {
                    queueAssistantBarRefresh(mutation.target);
                    if (findKnownUserContentTurn(mutation.target)) {
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

                if (findKnownUserContentTurn(mutation.target)) {
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
        renderTurns();
        observeChatChanges();

        /*
         * ChatGPT 的滚动容器不一定是 window，
         * capture=true 可以捕捉内部滚动容器的 scroll。
         */
        document.addEventListener(
            'scroll',
            scheduleActiveUpdate,
            true
        );

        window.addEventListener('resize', () => {
            updateRailDensity();
            scheduleActiveUpdate();
        });

        /*
         * 低频兜底。
         * ChatGPT 是 SPA + virtualization，
         * 即便某次 DOM 更新模式改变，也能自动恢复。
         */
        setInterval(() => {
            renderTurns();
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
