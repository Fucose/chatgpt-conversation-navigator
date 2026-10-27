# ChatGPT Conversation Navigator

为 ChatGPT 网页添加右侧会话导航、后台历史加载，以及当前回复导航。

## 安装

1. 在 Chrome 或 Edge 中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 首次使用时，在浏览器 [管理扩展](chrome://extensions/) 的扩展详情中，开启“允许用户脚本”。若链接无法点击，请在地址栏输入 `chrome://extensions/`（Chrome）或 `edge://extensions/`（Edge）。
3. 点击 [安装或更新脚本](https://gist.githubusercontent.com/Fucose/fc9f1963666d75e7f93a5edceae137c7/raw/chatgpt-conversation-navigator.user.js)，在 Tampermonkey 中确认安装。
4. 打开 [ChatGPT](https://chatgpt.com/) 会话。安装或更新时已有打开的页面，请重新加载一次，让新脚本生效。

## 使用

- **右侧导航**：普通问答每轮一根横条，独立简报每条一根。悬停查看内容预览，点击立即定位到对应消息；当前阅读的消息会高亮。定位已加载但未挂载的消息时，脚本先调用 ChatGPT 当前会话的原生定位能力；若不可用，会按估算位置进行有限的 DOM 搜索。搜索最多移动 24 步或持续约 8 秒，手动滚动、新跳转或切换会话时会取消。
- **加载全部历史**：当 ChatGPT 内部状态确认存在更早的消息时，导航上方才显示加载按钮；点击后在后台逐批加载更早消息，悬停时，图标左侧的弹窗显示当前状态。期间可以继续阅读、滚动和点击导航，脚本会保持阅读位置。短会话或原生分页状态尚未就绪时不会显示加载按钮。消息定位能力独立于分页加载，因此分页不可用时，已有导航仍可尝试定位已经加载的消息。
- **停止与继续**：加载时再次点击按钮可停止，已加载内容保留；之后点击可继续。全部历史加载完成后，按钮自动隐藏。
- **回到回复顶部**：阅读长回复、正文顶部离开可视区域时，聊天区域顶部会出现向上按钮。点击回到当前回复正文的开头；正文顶部可见时按钮隐藏。
- **当前回复大纲**：20×20 的纯图标按钮位于聊天顶栏最左侧、原生左侧栏右边，在项目名称或其他聊天顶栏内容之前；普通聊天不需要项目图标也能显示。按钮参考原生“更多”按钮设计，使用主色图标、无边框外观，以及悬停、按下和展开状态的灰色背景；大纲收起时，悬停或键盘聚焦会按原生提示样式显示“展开大纲”，提示与按钮左边缘对齐，放在顶栏外以避开裁切；大纲展开时不显示此提示。点击后，宽度为 300px 的大纲在左侧栏右边、顶栏下方展开，不为左侧六个导航按钮预留空隙，可以覆盖它们；窗口较窄时面板会进一步缩窄。大纲收集当前回复中带有 `data-d-component="title"` 属性，或旧版 `Heading-Ro3lZr` 类的 h1–h6 标题；会排除位于 `data-d-component="box"` 容器内的标题，仅将第一条显示为一级，其余条目保留原有层级和缩进，不改正文。标题和条目的字体分别参考原生任务面板的栏目标题与任务名称；条目上下内边距为 4px。只有标题列表滚动，正常字重的标题行保持可见。标题行最左侧的图钉用于固定大纲：固定时图钉为蓝色，点击大纲外部仍保持展开；取消固定后图钉为浅灰色，点击大纲外部会自动收起。固定状态和展开状态分别保存在当前浏览器配置中；新打开或重新加载页面、切换会话时，只有已固定且最近一次保存为展开的大纲才会自动展开；固定但已收起的大纲保持收起，未固定的大纲也不会因页面或会话变化自动展开。标题行右上角的两个箭头用于跳转上一条、下一条 ChatGPT 回复，悬停时显示无边框的浅灰色背景。点击标题会将它定位到固定顶栏下方；点击大纲内部、滚动或按 Escape 均保持大纲打开，顶栏大纲按钮始终可显式关闭。切换会话时会清除旧大纲；只有当前已固定且保存为展开的大纲才会自动展开新会话的大纲。
- **当前回复导航**：左侧栏右边的空隙内竖排显示六个按钮：上一条回复、回到回复顶部、上一个标题、下一个标题、跳到回复底部和下一条回复；按钮组在窗口垂直方向居中，并随侧栏展开、收起和尺寸变化移动。悬停时显示无边框的灰色背景。首尾箭头与大纲标题行的箭头共用回复切换功能，跳过尚未收到回复的用户消息，定位到相邻 ChatGPT 回复正文顶部；到达已知回复的首尾时，对应方向禁用。标题上下按钮仍按可视区内容上沿顺序前后移动，底部定位会避开输入框等遮挡层。左侧没有足够空隙时只隐藏这组导航按钮，不影响顶栏大纲。

导航会随当前会话和编辑后的消息分支更新。若分页状态确认仍有历史且加载失败，可点击按钮重试。控制台中的 `[Conversation Navigator]` 日志会说明原生定位/历史能力状态、加载按钮隐藏原因，以及加载或跳转的结果；日志不包含消息内容。

## 开发与发布

[GitHub 仓库](https://github.com/Fucose/chatgpt-conversation-navigator) 保存完整工程和提交历史；原 [Gist](https://gist.github.com/Fucose/fc9f1963666d75e7f93a5edceae137c7) 继续提供脚本安装和更新。脚本的 `@updateURL`、`@downloadURL` 和 Gist 文件名保持不变，现有用户无需重新安装。

本地检查无需安装依赖：

```sh
node --check chatgpt-conversation-navigator.user.js
node --test
git diff --check
```

### 首次配置 Gist 发布权限

1. 使用拥有原 Gist 的 `Fucose` 账号[创建个人访问令牌](https://github.com/settings/personal-access-tokens/new?name=Navigator%20Gist%20publish&target_name=Fucose&gists=write)。选择账号权限中的 **Gists: write**；无需授予仓库写入权限。默认的 `GITHUB_TOKEN` 仅能访问当前仓库，不能用于更新这个 Gist。
2. 打开仓库的 [Settings → Secrets and variables → Actions](https://github.com/Fucose/chatgpt-conversation-navigator/settings/secrets/actions)，点击 **New repository secret**，名称填写 `GIST_TOKEN`，值填写刚创建的令牌。
3. 令牌只保存在 GitHub Secret 中；到期后创建新令牌并更新同一个 Secret。

权限和设置说明见 [Gist 更新 API](https://docs.github.com/en/rest/gists/gists#update-a-gist) 和 [GitHub Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

### 发布新版本

1. 同时更新脚本头部的 `@version` 和启动日志中的版本号，完成检查后提交到 GitHub 的 `main` 分支。
2. 为该提交创建并推送同版本的标签。例如，发布 `0.5.2` 时：

   ```sh
   git push origin main
   git tag v0.5.2
   git push origin v0.5.2
   ```

3. 在 [Actions](https://github.com/Fucose/chatgpt-conversation-navigator/actions) 中查看 **Publish userscript to Gist** 的执行结果。

工作流 `.github/workflows/publish-gist.yml` 会检出标签对应的提交，运行语法检查和测试，确认标签与脚本版本一致，再通过 API 只更新 Gist 中的 `chatgpt-conversation-navigator.user.js`。发布后会核对该次 Gist 修订和现有更新地址返回的脚本内容，其他 Gist 文件保持原样。

需要重试时，可在该工作流页面点击 **Run workflow**，在 `tag` 中填写已有的发布标签。发布器拒绝降版，也拒绝以相同版本号发布不同内容；同版本且内容完全一致时允许重跑。日常推送 `main` 不会自动发布，Gist 由 Actions 同步，不再直接推送整个工程。
