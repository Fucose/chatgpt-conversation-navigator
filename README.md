# ChatGPT Conversation Navigator

为 ChatGPT 网页添加右侧会话导航、后台历史加载和当前回复顶部按钮。

## 安装

1. 在 Chrome 或 Edge 中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击 [安装或更新脚本](https://gist.githubusercontent.com/Fucose/fc9f1963666d75e7f93a5edceae137c7/raw/chatgpt-conversation-navigator.user.js)，在 Tampermonkey 中确认安装。
3. 打开 [ChatGPT](https://chatgpt.com/) 会话。安装或更新时已有打开的页面，请重新加载一次，让新脚本生效。

## 使用

- **右侧导航**：普通问答每轮一根横条，独立简报每条一根。悬停查看内容预览，点击立即定位到对应消息；当前阅读的消息会高亮。
- **加载全部历史**：点击导航上方的加载按钮，在后台逐批加载更早消息；悬停时，图标左侧的弹窗显示当前状态。期间可以继续阅读、滚动和点击导航，脚本会保持阅读位置。
- **停止与继续**：加载时再次点击按钮可停止，已加载内容保留；之后点击可继续。全部历史加载完成后，按钮自动隐藏。
- **回到回复顶部**：阅读长回复、正文顶部离开可视区域时，聊天区域顶部会出现向上按钮。点击回到当前回复正文的开头；正文顶部可见时按钮隐藏。

导航会随当前会话和编辑后的消息分支更新。若历史加载失败，可点击加载按钮重试。
