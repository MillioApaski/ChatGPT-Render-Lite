# ChatGPT Render Lite

一个实验性的 Tampermonkey 用户脚本，用于研究**减少 ChatGPT 长对话离屏消息的渲染成本**是否能改善滚动与交互流畅度。

> [!WARNING]
> **实验性功能，默认关闭。** 目前没有可靠的 A/B 数据证明它能改善性能；部分长对话可能出现滚动位置跳动、消息定位异常等问题。它不会修复 ChatGPT 自身 JavaScript 中的同步样式计算或强制布局问题。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 **[安装 ChatGPT Render Lite](https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-render-lite.user.js)**，在 Tampermonkey 安装页面确认安装。
3. 打开 ChatGPT，在 Tampermonkey 扩展菜单找到 **`ChatGPT Render Lite: 开启优化`** 并点击。
4. 刷新 ChatGPT 页面。需要回退时，从相同菜单关闭优化并刷新即可。

脚本通过 GitHub Raw 地址检查更新；已安装的用户会按 Tampermonkey 自身的更新策略获得新版本。

## 工作原理

启用后，脚本在检测到至少 **12 条对话消息** 时，为前面的历史消息应用以下 CSS，而保留最新 **6 条消息**的原始渲染行为：

```css
[data-chatgpt-render-lite] {
  content-visibility: auto;
  contain-intrinsic-block-size: auto 500px;
}
```

`content-visibility: auto` 允许 Chromium 跳过某些屏幕外子树的样式、布局和绘制处理。`contain-intrinsic-block-size` 为尚未完成布局的离屏元素提供估算高度，并允许浏览器记住其布局尺寸。实际效果取决于 ChatGPT 当前页面结构与滚动逻辑。

- 不调用 ChatGPT 的私有 API，不替换内部 JS 函数。
- 不拦截 `scroll` / `pointermove`，也不重写 `clientHeight` 等 DOM API。
- 每 5 秒检查一次对话消息，避免在高频输入事件中做扫描；隐藏页面不进行扫描。
- 仅在普通对话路由（包括 GPT 对话路由）设置优化标记；不会优化 Work 页面。
- 关闭优化时不注入 CSS，也不运行定时扫描。

脚本依赖 `[data-testid^="conversation-turn-"]` 选择器。如果 ChatGPT 更新页面结构，可能无法找到消息。开发者工具 Console 中的 `[Render Lite]` 日志会显示检测结果。

## 如何验证是否真的有效

请在**相同会话、窗口尺寸、缩放比例和操作流程**下，用 Chrome DevTools → Performance 对照录制：

| 组别 | 操作 |
| --- | --- |
| A：基线 | Tampermonkey 菜单关闭优化，刷新并录制 |
| B：实验 | 开启优化，刷新并重复相同交互 |

比较 `Recalculate Style`、`Layout`、最长交互长任务、滚动是否跳动；建议每组重复至少 3 次，避免把单次波动当成改善。

**注意：** 用户脚本无法保证消除 ChatGPT 的 `reconcileViewport → clientHeight → UpdateLayoutTree` 开销。任何“提升百分比”都必须来自独立测试，而非从初始 Trace 推算。

## 开发

无需构建工具或外部运行时依赖，用户脚本入口：[`chatgpt-render-lite.user.js`](./chatgpt-render-lite.user.js)。

可选的基础逻辑测试（需要 Node.js）：

```bash
node --test tests/*.test.cjs
```

这些测试只验证菜单开关、路由与消息标记逻辑，**不代替在真实 ChatGPT 页面进行 Performance A/B 测试**。

## AI 生成声明

本项目的代码与文档由 OpenAI ChatGPT（GPT-6）辅助生成，尚未经过完整的真实页面性能验证。
