# Phase 5：性能瓶颈定位（只读诊断）

本阶段**不修改原有 Render Lite 或 Phase 4 几何缓存脚本**，新建一个完全独立的、用户主动启用的只读诊断脚本：

[安装 Phase 5 Diagnostics（PR 分支）](https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/phase5-performance-diagnostics/chatgpt-phase5-diagnostics.user.js)

> 诊断工具不等于优化工具。无真实浏览器 A/B 测试结果之前，不宣称修复了卡顿。

## 已有证据

2026-10-16 性能分析报告（当时的 Trace；不保证适用于今天的 ChatGPT）确认：

- 22.316 秒录制，19 个 >50ms 主线程 RunTask。扣除录制器启动后，18 个属于交互窗口。
- 最慢实际 click RunTask 851.980ms；另一 click 663.985ms。
- 10.5 秒左右的 scroll 任务中，`reconcileViewport → get clientHeight → UpdateLayoutTree` 伴随 **97.151ms 同步 Style**，后续微任务有 **46.913ms Style**。同类链路在 19.9/20.6 秒再次出现。
- 全窗口互斥 Style 2144.284ms、Layout 292.356ms，JavaScript/dispatch 4989.106ms。各类别互斥，但函数包容时间与 Style 不能重复相加。
- 该 scroll 路径**证明同步样式刷新但没有证明实际 Layout**。某些 click 任务中另有同步 Layout。尚不能归因到某个 React commit、Markdown 解析函数、CSS 选择器或某个扩展。

## 安装和采样

1. Tampermonkey 安装上方独立脚本。
2. **关闭 Render Lite 主脚本优化**，将 Phase 4 模式改为 `off` 并刷新。测量原网页时尽可能禁用其他用户脚本/扩展（或用独立浏览器配置文件登录）。
3. 打开同一条长对话，在 Tampermonkey 菜单点击 **Phase 5：开始采样**。初始静置 3～5 秒。
4. 按固定动作操作一段时间：例如滚动长对话、点击展开/收起、切换会话或输入。对照组必须使用**相同对话、相同窗口尺寸、相同缩放比例、相同动作类型**。
5. 点击 **Phase 5：停止采样**，再点 **Phase 5：导出 JSON 报告**。所有数据均下载到本地，不上传。
6. 至少做 3 次 A（全扩展和 Render Lite 关闭）、3 次 B（仅 Render Lite 开启），如需验证 Phase 4，C 组需独立测试。
7. 使用 Chrome DevTools Performance 另录制一次短窗口（仅录卡顿前后 5～15 秒），保留 CPU sampling、screenshots 与 source events。**不建议把持续 DevTools CPU 录制与平时性能基准混为同一组。**

## 诊断字段

| 字段 | 意义 | 限制 |
| --- | --- | --- |
| `longTasks` | 主线程 Long Tasks API 报出的任务 | 与 DevTools 顶层 `RunTask` 不是相同定义 |
| `loafs` | Long Animation Frame (>50ms) | 只涵盖长帧，不是全部帧耗时 |
| `loafs[].scripts` | 长帧中较耗时的脚本归因（每帧至多 4 个） | 仅部分脚本；不能推断全部 JS 自耗时 |
| `forcedStyleAndLayoutMs` | 脚本运行中同步样式/布局成本 | 不区分 Style 和 Layout 时仍可用 |
| `styleMs` / `layoutMs` | Chromium 支持时的细分时间 | 不支持时为 null，不是 0 |
| `events` | Event Timing 中超过阈值的事件及其输入延迟、处理、呈现延迟 | 不是标准 INP；未报告的短事件不计 |
| `turnSamples` | 每 5 秒采样一次消息节点数量 | 仅作趋势观察 |
| `startSnapshot` / `endSnapshot` | 页面 DOM 数、JS Heap 近似值 | Heap 接口非标准且跨站点不一定可用 |
| `summary.topScriptSourcesFromRetainedLoafFrames` | 已保留长帧中脚本来源的局部统计 | **不能视为整体 CPU 火焰图** |

采样每种记录最多保留 600 条，原始总数单独计数；若触发上限，分位数只能描述**保留的后 600 条**，不代表全时段。脚本不会读取、导出聊天内容、会话路径、提示词、网络请求、Cookie、Token，也不会操作 ChatGPT 私有对象、DOM 样式或几何 getter。

## 如何区分主要嫌疑

- **输入延迟主导**：`events.inputDelayMs` 高，查阻塞队列的长任务、定时器、框架更新和扩展。
- **事件处理主导**：`events.processingMs` 高，结合 LoAF `scripts.source` 定位 JS URL，再去 DevTools Bottom-up / Call tree 分析。
- **呈现延迟主导**：`events.presentationDelayMs` 高，检查 Style/Layout/Paint。单靠事件数据不能断言是布局。
- **强制样式或布局主导**：LoAF `forcedStyleAndLayoutMs` 高，DevTools 看 `UpdateLayoutTree` / `Layout`、`Forced reflow` 和来源栈。
- **Markdown / React**：只读 API **无法直接给出可靠的 React commit 次数或 Markdown AST 解析次数**；必须在 DevTools CPU profile 中检查调用栈或用应用源码级别 instrumentation。不能把所有 DOM 更新归因于 React，也不能凭代码块多就认定 Markdown 是主因。
- **扩展污染**：干净配置文件与含扩展的配置做相同操作的多轮对照，单次差异不能证明因果关系。

## 2026-11-16 长对话实测的新增发现

用户提供一份 24.04 秒采样：操作是切换到长对话、向上查看历史消息。

- 67 个 Long Animation Frames，P95 481.8ms，最大 1099.3ms；71 个 Long Tasks，最大 997ms。最长帧出现在开始约 2.13 秒，晚于 20 秒仍有 546.8ms 长帧，不能用单次打开解释整段体验。
- 在 LoAF 的部分脚本记录中，`76629.9835d52bf1.js` 耗时 1941.2ms、强制样式/布局 1838.9ms；`226913.dd4de34d8f.js` 为 3193.4/1182.4ms；`843292.e99f82cf4b.js` 为 1793.7/747.1ms。**这些数字为 LoAF 捕获的部分脚本耗时，不是去重后的全页面 CPU 预算**。
- `turns` 在所有样本均为 0，但页面总 DOM nodes 1644 → 2087。现有 Conversation Turn 选择器显然不能可靠提供对话规模，**不推断长对话只有零条消息**。v0.1.1 为多个候选选择器分别报告计数，无法识别时 `turns=null`。
- Event Timing 474 条均为 pointerenter/leave/over/out 等指针过渡事件，所有 `interactionId=0`，只有 18 种起始时间戳。**474 不是 474 次独立用户操作，也不能用这些记录声称 INP 520ms。** v0.1.1 在摘要单独列出与指针过渡相关的条目数和非零交互 ID 条目数。
- Heap 199MB → 478MB，可能由会话切换及页面加载引起，不能认定内存泄漏。第一帧和后续滚动阶段的具体时间边界本次未记录，不能精确分配责任。

**下一组测试：** 打开同一长对话后先静置到稳定，再启动 15～20 秒采样，整个窗口仅向上滚动，停止后导出。至少重复 3 次。在干净浏览器配置中复现后，使用 DevTools Performance 重点展开 `76629…js` 关联的 Forced style/layout stack 与 DOM invalidation；只有得到对应调用栈才能确定是 CSS 样式失效、布局测量、回调循环还是页面框架的问题。

## 验收标准

1. 首先获得干净环境的 A 组和实际使用环境的 B 组各 3 次报告，且观察窗口与动作相近。
2. 明确列出每组最大的 Event Timing 事件、长帧、长任务、最重脚本来源，及 LoAF 中强制样式/布局。
3. 把真正的慢帧与 DevTools Performance 调用栈关联，判断是 Style、Layout、脚本执行、GC 或另一个来源。必要时重录带样式失效信息的 Trace。
4. 最后才决定是否值得进一步做自定义 UI：如果瓶颈在原站 React/布局/Markdown，覆盖式 UI 不一定有帮助，必须考虑移除原渲染树或使用独立客户端。

## 参考

- [Chrome：Identify causes of poor INP](https://developer.chrome.com/docs/modern-web-guidance/guides/performance/identify-inp-causes)
- [GoogleChrome web-vitals：INP 及 attribution](https://github.com/GoogleChrome/web-vitals)
- [Chrome：Forced reflow](https://developer.chrome.com/docs/performance/insights/forced-reflow)
