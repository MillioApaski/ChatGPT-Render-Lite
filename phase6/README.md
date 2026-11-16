# Phase 6：独立轻量消息渲染器，可行性原型

## 它做什么，不能做什么

这是一个**独立运行、不加载 chatgpt.com 页面代码**的消息列表原型。针对 Phase 5 的浏览器 Trace，验证“消息只保留视口附近的 DOM 节点，滚动时不调用原站组件和 `scrollend` 回调”这一架构是否可行。

它支持：
- 100、1,000、5,000、10,000 条**长度不等**的合成消息，含标题、段落、列表、代码块，以及用于验证安全性的 HTML 字符串。
- 变高虚拟列表：Fenwick 树保存估算高度和 ResizeObserver 测量结果，支持 O(log n) 的位置查询、更新；视口上下各 900px 作为预渲染缓冲。**不触发原站的滚动、React 或几何测量代码。**
- 从顶部插入 50 条较早的消息并保持阅读位置；按索引跳转到中间。
- “全部 DOM”对照模式，最多 1,200 条消息，以免无意卡死浏览器。
- 用户**主动选择本地导出的 `conversations.json`**，在独立 Web Worker 中解析，选择一条对话并读取当前分支的用户与助手文本消息。
- 90 步逐帧从底部到顶部的程序化滚动；记录 rAF 间隔、Long Tasks、Long Animation Frames、渲染节点数量。可以重复运行虚拟列表与全部 DOM 对照。

它**不**实现 ChatGPT 在线对话、Plus 会话接口、文件/图片渲染、编辑、分支切换、数学公式、完整 Markdown/DIL，**也不会接管或停用 chatgpt.com 当前页面**。本地导出只适合验证真实文本规模和独立渲染器成本，不能证明在线集成可行。

## 运行方法（Windows PowerShell）

```powershell
git clone -b feature/phase6-virtual-renderer-poc https://github.com/MillioApaski/ChatGPT-Render-Lite.git
cd ChatGPT-Render-Lite/phase6
py -m http.server 8000
```

在浏览器访问 **http://localhost:8000**。

重要：不要双击打开 `index.html` 用 `file://` 协议，模块 Worker、相对路径和导入可能受浏览器安全策略限制。无需 npm、构建服务、云端后台或 API Key。所有逻辑在浏览器本地运行。

## 使用真实数据

1. 通过 ChatGPT 的数据导出功能取得导出包，解压，找到 `conversations.json`。
2. 在原型里使用“导入自己的记录”选择该文件；解析**仅在本地 Web Worker**执行。
3. 在标题搜索框筛选会话，列表只显示前 200 个匹配项；当前选择的会话只显示**其 current_node 祖先链的用户及助手文本消息**。
4. 对同一条会话分别尝试虚拟列表和全部 DOM（若消息不超过 1,200 条），保持相同窗口大小，运行“自动向上滚动并测量”至少三次。

为避免浏览器因超大 JSON 失去响应，原型暂不接受 **>250MB** 的导出文件。Web Worker 只把所选会话的消息传回主线程；原始导出数组仍保留在 Worker 内。没有主动网络请求，不使用 localStorage 存储对话，不执行消息内 HTML，所有文本通过 `textContent` 渲染。

## 如何读基准数据

- `rAF P95`：基准期间相邻 `requestAnimationFrame` 回调时间间隔的 95 分位；并非渲染 CPU 专属时间，也不是 INP。
- `>50ms 间隔`：基准采样里帧间距 >50ms 的次数；不能直接推算掉帧率。
- `Long Tasks`：长任务 API 的记录数；`Long Frames`：Long Animation Frame API 的记录数。不同于 DevTools trace 主线程顶层 RunTask。
- `全部消息`：数据集大小；`当前挂载`：实际消息节点数量。虚拟模式应随视口大小变化，不应随总消息线性增长。
- `最近一次渲染耗时`：仅测列表同步 DOM 逻辑，不包括异步 Style/Layout/Paint；不能拿它替代 DevTools 火焰图。
- `当前主文档 DOM 元素`：这一独立页面的 DOM 元素总数，不是 chatgpt.com 的真实 DOM 规模。
- `JS Heap`：非标准 Chromium `performance.memory` 指标，可能不支持，不是可靠泄漏检测。

**对照限制：** 程序化 `scrollTop` 和真实鼠标滚轮并不完全相同。导入后这里展示的是简化文本内容，因此即使指标好，也不能当作“ChatGPT 实际滚动提升 X%”的实测结果。公平评估应固定相同数据、尺寸、浏览器和重复次数；需要对原站录制同类操作的 DevTools Trace。

## 技术结构

| 文件 | 职责 |
| --- | --- |
| `height-index.mjs` | Fenwick 树、基于估算/真实高度求可视范围 |
| `virtual-list.mjs` | 只创建近视口 DOM；ResizeObserver 更新实际高度；顶部插入时修正滚动位置 |
| `export-parser.mjs` | 无副作用的 ChatGPT 导出解析器，只提取 current_node 祖先链 |
| `import-worker.mjs` | 本地文件解析与目录检索，避免主线程 JSON.parse |
| `fixtures.mjs` | 可复现的混合长度合成数据 |
| `app.mjs` | 演示交互、对照模式、基准与观测器 |
| `theme.css` / `index.html` | 独立页面，不使用原站 CSS |

## 验收与未来决策

1. **功能验收**：10,000 条消息时视口附近保留几十个而不是上万个 DOM 消息节点；跳转、滚动、前插入保持合理阅读位置。Node 单元测试+Chrome 真实浏览器测试应通过。
2. **性能验收**：在相同的 100/1,000 条模拟数据上对比虚拟和全部 DOM；真实导出对话复测。没有实际浏览器结果时，不应声称某个倍数。
3. **体验验收**：特长消息、代码块、动态高度、长距离跳转不出现空白或严重锚点漂移；失败时反馈。
4. **在线可行性仍未解决**：如果要沿用 ChatGPT Plus 登录与会话能力，不能靠本原型证明已找到稳定可用的内部消息接口。继续选择“原站 DOM 覆盖”会保留 Phase 5 的 `scrollend` 强制布局瓶颈。下一步只能在明确支持的集成方案与单独付费的官方 API 客户端之间做取舍，不能把未经证实的私有端点当交付条件。

## 已知缺口

目前的 Markdown 解析只支持纯文本、标题、列表和三反引号代码块的安全显示，不支持完整表格、图片、数学公式、多模态卡片或 DIL。导出格式可能随 ChatGPT 版本变动。虚拟高度初始使用估值，远距离跳转后可能需要 ResizeObserver 修正。插入历史记录时初始使用估算高度保留位置；特别长的历史条目需要验证是否出现轻微抖动。
