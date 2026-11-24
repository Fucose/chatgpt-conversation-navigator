# ADR 0001：原生滚动所有权

- 状态：accepted
- 日期：2026-11-20
- 替代：无

## 背景

ChatGPT 新虚拟列表提供内部 `turnListApi.scrollToKey`，但该方法可能在目标行高度真正提交前返回；目标渲染行不存在时，它还可能只按虚拟列表估算把目标行带入视口。目标行随后被回收时，脚本如果立即再次调用原生定位，会形成持续重排。

同时存在多层历史兼容：

- 新 `turnListApi.scrollToKey`；
- 旧 `ref.scrollToMessage`；
- 两种原生定位都不可用时的 DOM 有界搜索；
- 历史分页使用动态发现的 `AppScope + loadPrevious`。

当前页面实测有完整消息 ID 和 `turnKey`，排除了“消息缺少定位符”的结论。

## 决策

当存在新原生定位接口时，脚本在请求开始前就把 `nativeScrollOwned` 设为真，避免旧 DOM 校正与原生请求交叉。虚拟行被回收时，允许通过 `getEntryGeometry.startPx` 做一次受限重入。

布局稳定后，脚本允许做一次顶部校准并设置 `nativeAlignmentComplete`。校准完成后，目标再次被虚拟列表回收时结束本次自动恢复，不再持续调用 `scrollToKey`。原生恢复总次数有上限，避免逐帧或逐秒重试。

旧 `ref.scrollToMessage` 和 DOM 有界搜索保留为低优先级回退，并且只在对应原生接口不可用时执行。

历史分页继续使用动态发现的 `loadPrevious`。不直接复制页面的 `backend-api/conversations/...` 请求，因为原生 loader 还维护会话状态、分页游标、缓存和分支语义。

`measureTurnBeforePaint` 当前不调用。2026-11-20 的 Edge 实验显示它会触发表格自身约 `647px` 的 padding 和持续高度切换，不能作为无副作用的布版提交屏障。

## 后果

- 原生滚动负责进入目标区域，DOM 只在稳定后做一次顶部校准。
- 目标行在高度提交前被回收时，几何位置重入可以避免永无止境的 `scrollToKey → 回收 → scrollToKey`。
- 校准完成后自动恢复会停止，用户再次点击仍可发起新的显式导航。
- 当前页面仍保留旧版本兼容能力，但每条路径有明确优先级。
- 脚本增加 `nativeScrollOwned`、`nativeAlignmentComplete` 和恢复次数状态，调试时必须同时检查目标挂载、滚动高度稳定性、原生请求、恢复请求和 DOM 回退是否被误启用。
- ChatGPT 内部接口一旦改名或移除，需要重新实测接口矩阵；回退逻辑提供时间窗口，但不保证永久兼容。
- 未来若官方修正 `measureTurnBeforePaint` 的 padding 副作用，可以另行评估新的稳定屏障，不需要修改本条所有权原则。
