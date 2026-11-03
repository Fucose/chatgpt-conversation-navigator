# ChatGPT Conversation Navigator

为 ChatGPT 网页添加右侧会话导航、后台历史加载，以及当前回复导航。

## 安装

1. 在 Chrome 或 Edge 中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 首次使用时，在浏览器“管理扩展”中进入油猴扩展的“详细信息”，开启“允许用户脚本”。
     进入扩展管理界面，请在地址栏输入 `chrome://extensions/`（Chrome）或 `edge://extensions/`（Edge）。
3. 点击 [安装或更新脚本](https://gist.githubusercontent.com/Fucose/fc9f1963666d75e7f93a5edceae137c7/raw/chatgpt-conversation-navigator.user.js)，在 Tampermonkey 中确认安装。
4. 打开 [ChatGPT](https://chatgpt.com/) 会话。安装或更新时已有打开的页面，请重新加载一次，让新脚本生效。

## 使用

- **右侧导航**：悬停横条预览内容，点击跳转到对应消息；当前阅读位置会高亮。
- **加载全部历史**：点击导航上方的加载按钮，在后台加载更早的消息；再次点击可停止，之后可继续。全部加载完成后，按钮自动隐藏。
- **当前回复大纲**：点击聊天顶栏左侧的大纲按钮，查看当前回复的标题，点击标题跳转。点击图钉可固定大纲，点击外部时保持展开。
- **当前回复导航**：使用左侧按钮切换上一条或下一条回复、跳转上一个或下一个标题，或跳到回复顶部与底部。
- **回到回复顶部**：阅读长回复时，聊天区域顶部会出现向上按钮，点击即可回到当前回复开头。
