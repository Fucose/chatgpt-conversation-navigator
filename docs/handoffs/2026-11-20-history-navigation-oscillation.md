# 交接：历史加载与消息导航循环修复

## 2026-11-24 发布检查点

- 用户反馈：仓库最新脚本连续实测数日未发现问题，并明确授权将全部改动 Git commit、push，然后发布用户脚本到现有 Gist。以下 2026-11-20 的“未授权”状态是历史记录，已由本次授权取代。
- 目标：`main` 分支、`v0.5.6`；用户脚本 `@version` 与启动日志均升级为 `0.5.6`，保留原 Gist 文件名及更新/下载地址。README 已补充用户可见的修复说明。
- 范围：全部现有用户脚本、四个相关测试、`AGENTS.md`、`docs/`，以及本次 README 和发布记录更新。
- 发布前验证：Node.js `v24.21.0`；`node --check chatgpt-conversation-navigator.user.js`、`node --test`（166 passed，0 failed，0 skipped）、`git diff --check` 均通过。
- 差异审查：无发布阻塞。记录一个尚未复现的非阻塞边界：`jumpToIdentity` 在等待原生定位期间，如果最初已挂载的目标被回收且定位未返回新节点，可能保留断开的旧节点并跳过 DOM 搜索。本次用户实测和既有 Edge 验证均未出现该情况，后续有复现再处理。
- 远端检查：`origin/main` 与基线 `9dcdeb5ab5dadcc9141e38af41fb577ec67d4ae7` 一致，`v0.5.6` 在本地及远端均未占用，现有 Gist 仍为 `0.5.5`。
- 浏览器证据：本次通过 `connect-windows-edge` 和 `agent-browser` 连接现有 Edge，确认 ChatGPT 会话及回复导航控件存在；导航交互回归沿用下文 2026-11-20 的 Edge 验证和用户随后数日实测，本次未重新注入脚本或重复完整交互。
- 本交接记录的是提交前检查点。后续按 `AGENTS.md` 审查并提交全部已批准路径，创建 annotated Tag，原子推送分支和 Tag；等待匹配 Tag commit 的 `publish-gist.yml` 成功后，分别比对 Gist revision URL 与稳定更新 URL 的 SHA-256。
- 恢复时先检查 `git status`、[v0.5.6 Tag](https://github.com/Fucose/chatgpt-conversation-navigator/releases/tag/v0.5.6) 和 [发布工作流](https://github.com/Fucose/chatgpt-conversation-navigator/actions/workflows/publish-gist.yml)，确认实际完成阶段；不要重复提交或改写已发布版本。

## 2026-11-20 实现交接（历史记录）

- 时间：2026-11-20 12:47 HKT
- 计划：[HISTORY-NAV-OSCILLATION-2026-11-20](../plans/2026-11-20-history-navigation-oscillation.md)
- 分支：`main`
- 工作区：仓库根目录
- HEAD：`9dcdeb5`（`v0.5.5`）

## 范围与所有权

- 已处理任务：修复 ChatGPT 改版后“加载全部历史”和历史横条跳转不稳，特别是倒数第二条消息的持续上下跳动。
- 当前阶段：实现与验证完成，等待代码审查及是否提交的后续授权。
- 后续工作所有权：尚未分配给其他代理。
- 已存在的 dirty 路径：`AGENTS.md`、`chatgpt-conversation-navigator.user.js`、`conversation-store.test.cjs`、`native-adapter.test.cjs`、`native-locator.test.cjs`、`reply-navigation.test.cjs`，以及本次新增的 `docs/` 文档。不要覆盖或回退这些修改。

## 进度与证据

- 当前消息模型具有唯一 `turnKey` 和完整用户消息 ID；当前 DOM 的用户消息外层单元携带同一 ID。
- 当前页面已没有旧 `ref.scrollToMessage`；新 `turnListApi` 提供 `scrollToKey`、`getRowElement` 等能力。
- 原动态 `loadPrevious` 仍可加载一页历史并进入 complete。
- 根因是官网虚拟列表高度异步提交，加上脚本在目标行回收后反复调用原生定位；不是缺少定位符，也不是业务内容再次请求。
- 精确补充复现为第 4 轮“介绍该开源项目的架构” → 第 5 轮“如果不用 Nvidia…”。
- 已实施原生几何重入、布局稳定后一次性顶部校准、恢复次数上限和校准完成后停止自动恢复。主要代码见 [createNativeLocator](../../chatgpt-conversation-navigator.user.js#L2475)、[correctForegroundTarget](../../chatgpt-conversation-navigator.user.js#L8378)、[locateNativeSearchTarget](../../chatgpt-conversation-navigator.user.js#L8494)、[waitForForegroundSettle](../../chatgpt-conversation-navigator.user.js#L8658) 和 [jumpToIdentity](../../chatgpt-conversation-navigator.user.js#L8719)。
- 回归测试见 [stable geometry fallback](../../native-locator.test.cjs#L142) 和 [native-owned foreground alignment](../../reply-navigation.test.cjs#L2024)。
- 检查：`node --check chatgpt-conversation-navigator.user.js` — 通过，2026-11-20；最终工作区状态为 dirty。
- 检查：`node --test` — 166 passed，0 failed，0 skipped，2026-11-20；最终源码与测试状态未变。
- 检查：`git diff --check` — 通过，2026-11-20。
- 真实浏览器：Windows Edge 完整历史加载后，第 4 轮 → 第 5 轮连续三轮；每轮只产生两次原生定位，没有恢复调用。稳定状态为 `height=31781`、`top=22448`、目标渲染行 `y=60px`，padding 为空，第 5 轮横条 active。
- 干净环境：重新注入不带调试代码的最终脚本后重复同一顺序，最终状态与三轮追踪一致。
- 未验证：其他会话 ID、长期页面运行、ChatGPT 后续发布后的内部接口稳定性。

## 影响、阻塞与决策

- API/UI 影响：消息滚动路径新增原生所有权；历史按钮和用户消息 ID 解析兼容新 DOM。
- 数据/配置影响：没有数据迁移或配置变更。
- 已接受决策：[ADR 0001 原生滚动所有权](../decisions/0001-native-scroll-ownership.md)。
- 已知阻塞：无。
- 未执行动作：没有提交、推送、版本升级、Tag 或 Gist 发布。当前工作区变化不等于发布授权。

## 下一步

1. 审查用户脚本、测试和 `docs/` 的未提交 diff，确认修复范围。
2. 如果代码继续变化，重新运行语法检查、相关测试、全量测试和 `git diff --check`。
3. 在获得提交/发布授权后，按 [AGENTS.md](../../AGENTS.md) 的版本和 Gist 流程处理。
4. 更新 Tampermonkey 本地脚本，在至少另一个长会话中抽查历史加载和虚拟化消息跳转。
