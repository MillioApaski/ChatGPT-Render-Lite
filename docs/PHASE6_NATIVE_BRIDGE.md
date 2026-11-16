# Phase 6.1：原版 ChatGPT 消息渲染桥接实验

> 高风险实验，默认完全关闭。仅在不重要的长对话中测试，不能作为日常聊天界面。

本实验沿用 Phase 6 虚拟消息列表，在原版 chatgpt.com 里做三个阶段的验证：识别现有消息 DOM、显示独立只读镜像、经过确认后将原消息列表暂时移出可见布局。Plus、模型选择、输入框、侧边栏、服务器连接仍由原版网页提供。

**这不是 React 真正卸载或替换：** takeover 仅对经过验证的消息根节点设置 display:none!important，同时显示自定义虚拟列表。原 React 仍可能运行，只有真实 Performance Trace 才能证明同步 Style/Layout 或滚动事件开销减少。

## 安装和操作

[从实验分支安装独立 Tampermonkey 脚本](https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-native-render-bridge.user.js)

关闭其他 Render Lite / Phase4 脚本后，刷新 chatgpt.com，进入普通长对话。在 Tampermonkey 菜单依次尝试：

1. **Phase6：扫描页面结构**，在 Console 查看候选消息选择器、正文容器命中数、main 数量和推断行数。完全只读，不输出聊天文本。
   - 老选择器全为 0 **并不代表没有消息**；新版本会继续扫描 `.markdown`、`.prose` 和消息正文类名，并尝试从重复的兄弟节点推断消息列表根。
   - 检查日志里的 `containers[0].candidate.rows`：如果有合理的消息数，先运行预览验证。
   - 如果 `mainCount=0` 或找不到候选，不要尝试接管模式；使用下一项手动定位或提供匿名结构统计。
2. **Phase6：点击消息定位容器**（v0.2.0 新增）：自动识别失败时，进入一次性点选模式。**点击一条历史消息正文**，脚本按其 DOM 祖先和兄弟节点推断容器，不隐藏任何消息。按 Esc 取消。成功后 Console 只输出数量及容器标签，不会输出消息内容。
3. **Phase6：只读 React 组件路径**，只显示至多三条消息节点的 React Fiber 类型链，不读取 props 或消息内容。
4. **Phase6：预览轻量渲染器**，浮层展示原消息文本，原页面仍保持可见。
5. **Phase6：实验性隐藏原消息区域**，会出现确认框，确认后仅原消息列表被隐藏，独立浮层显示只读镜像。Esc 或面板“恢复原版”可还原。
6. **Phase6：恢复原网页**，清理 Observer、滚动回调、浮层，恢复原节点的原始 display 样式。
7. **Phase6：设置消息 CSS 选择器**，自动识别失败时手动指定“每条消息”的选择器，留空恢复自动发现。不得指定 main、body 或包含输入框的祖先。

Console API：

~~~javascript
ChatGPTRenderLiteBridge.probe()
ChatGPTRenderLiteBridge.pick() // 然后点击一条历史消息，Esc 取消
ChatGPTRenderLiteBridge.fiberProbe()
ChatGPTRenderLiteBridge.start('preview')
ChatGPTRenderLiteBridge.start('takeover') // 会弹出二次确认
ChatGPTRenderLiteBridge.status()
ChatGPTRenderLiteBridge.restore()
ChatGPTRenderLiteBridge.setSelector('main article') // 仅作示例
~~~

## 保护措施

- **默认关闭**，不监听页面 Mutation，也不自动扫描消息。
- 只有被识别为同一个 main 内、与输入框分离的列表根节点才能隐藏；拒绝隐藏 main、body 或输入框所在的节点。
- 限制最多 1200 条、每条 30000 字符、总共 3000000 字符。识别失败或列表结构异常时停止。
- 切换 SPA 会话路由、消息根节点被卸载，都会自动退出实验。用户也可按 Esc，或禁用脚本并刷新。
- 本地只读文本，所有内容使用 textContent 渲染，不执行 HTML，不上传数据，不拦截网络接口。
- **React Fiber 只读元信息探测，不修改或替换 Fiber、React state、内部函数。**

## 成功标准和未知点

Phase 5 Chromium Trace 曾显示：38 次 scrollend 分发累计约 1.70 秒，其中约 1.65 秒为同步 Style/Layout。需要在同一会话分别录制 **原版**和 **takeover**，每组至少 3 次，检查：

- scrollend、getBoundingClientRect、UpdateLayoutTree、Layout 是否明显下降；
- 50ms 以上长任务数、最大持续时间，以及主线程总耗时；
- 输入框、滚动定位、消息同步、会话切换及随时恢复是否正常。

不能仅凭浮层挂载了更少消息就宣称修好了卡顿。原 React 在隐藏 DOM 后仍存在，可能继续执行 JS。

**已知限制：** 即使 v0.2.0 自动结构推断或点选成功，也**不能保证推断的每行恰好对应一条真实消息**。必须先在预览模式核查顺序、角色和内容；未标记角色的消息会显示为“unknown”，不会擅自当成助手。点选流程也仅作用于当前对话路由，切换会话后需要重新确认。无 `main` 或闭合 Shadow DOM 情况仍可能无法识别。镜像仅为简化文本，复杂 Markdown、图片、DIL、多模态和消息内部按钮不可用。流式更新以约 450ms 节流同步。任何页面异常请恢复原版。

代码和测试：仓库根目录独立脚本，以及 tests 目录下 Phase6 原网页桥接测试。不会改动现有主脚本。
