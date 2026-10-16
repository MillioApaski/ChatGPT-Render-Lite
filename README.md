# ChatGPT Render Lite

一个实验性的 Tampermonkey 用户脚本，用于研究**减少 ChatGPT 长对话离屏消息的渲染成本**是否能改善滚动与交互流畅度。v0.3.0 新增可选的 **Viewport Guard** 模式。

> [!WARNING]
> **实验性功能，优化总开关默认关闭，Viewport Guard 默认不启用。** 初步 Performance 截图中的耗时占比有正向迹象，但录制时长和操作条件不同，尚未证明可靠的实际加速；部分长对话可能出现滚动位置跳动、消息定位异常等问题。它不会直接修复 ChatGPT 自身 JavaScript 中的同步样式计算或强制布局问题。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 打开 **[安装 ChatGPT Render Lite](https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-render-lite.user.js)**，在 Tampermonkey 安装页面确认安装。
3. 打开 ChatGPT，在 Tampermonkey 扩展菜单找到 **`ChatGPT Render Lite: 开启优化`** 并点击。
4. 刷新 ChatGPT 页面。需要回退时，从相同菜单关闭优化并刷新即可。
5. **Phase 3 可选实验**：在 Tampermonkey 菜单中点击 `Render Lite 模式: 经典模式（点击切换）`，会切换至 `Viewport Guard 实验` 并刷新。原有经典模式仍是默认模式。

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

## Phase 3：Viewport Guard（v0.3.0，默认不启用）

第一阶段 Trace 记录了 `scroll → reconcileViewport → clientHeight → UpdateLayoutTree` 的同步样式刷新。**Viewport Guard 不会拦截或替换该函数。** 它只尝试减少本脚本的 containment CSS 与视口附近几何测量之间的冲突，效果仍需实测。

- 使用 `IntersectionObserver` 判断消息是否在视口上下各 **900px 缓冲区**内，无需主动读取布局尺寸。
- 缓冲区内的历史消息及相邻各一条消息不使用 Render Lite containment，远处历史消息继续使用 `content-visibility: auto`。
- 刚开始观察时，如果可见性状态尚未返回，暂不为对应消息添加 containment。
- 滚动发生时延迟本脚本对 DOM 的样式标记更新，约 **220ms 无 scroll 事件** 后再执行；每轮最多更新 **24** 个消息节点。
- 最新六条消息不优化；不拦截滚动、React、`clientHeight` 或 ChatGPT 的私有函数。
- 缺少 `IntersectionObserver` 时自动使用经典模式。

> **风险：** Viewport Guard 多了 IntersectionObserver 和一个被动 scroll 监听，未必比经典模式快。它可能与嵌套滚动容器、特长消息和滚动定位产生副作用，须在长对话中验证。

### 三组性能对比

| 组别 | 设置 |
| --- | --- |
| A | 关闭 Render Lite |
| B | 开启 Render Lite，经典模式 |
| C | 开启 Render Lite，Viewport Guard 模式 |

保持同一对话、窗口尺寸、缩放比例和操作轨迹，每组重复至少三次。重点比较单位时间 Style/Layout、超过 50ms 的主线程任务次数及最大耗时、`reconcileViewport` 相关同步样式刷新，以及滚动是否跳动。**不要把录制时长不同的 Bottom-up 百分比变化当作确定的性能收益。**

### 验证状态

- Node.js 基础逻辑测试与 CI：用于确认功能完整性。
- Chrome 真机 Performance A/B：**尚待验证**，不能据此声称已修复 ChatGPT 性能瓶颈。
## Phase 4：运行时几何读取实验（独立脚本）

> [!CAUTION]
> **高风险实验，必须手动安装和启用。默认完全关闭。**
> `cache` 模式可能在同一个滚动事件内返回短暂过期的 `clientHeight`，影响滚动定位、浮层位置或布局。没有真实网页验证，**不推荐日常使用**。这是实验性局部 DOM getter 补丁，不是对 ChatGPT `reconcileViewport` 私有函数的直接修改。

该阶段为独立、可卸载的伴随脚本，**不更改 v0.3 经典模式 / Viewport Guard 代码**：

[安装 Phase 4 Geometry Cache](https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/main/chatgpt-geometry-cache.user.js)

主世界运行机制使用 `@grant none`、`@sandbox raw` 与 `@run-at document-start`。如 Tampermonkey 因 CSP 或注入环境限制未成功补丁，不要假定已经生效，需检查状态中的 `patchedTargets`。

### 三种运行模式

- `off`（默认）：不安装事件监听器、不修改 getter。
- `observe`：仅在真正发生滚动、且滚动容器包含聊天消息时，为**最多两个滚动元素自身**添加 `clientHeight` 测量包装，不缓存返回值。
- `cache`：在 observe 基础上，对**同一滚动事件序号中 8ms 内**的重复读取短期复用结果，每次原生读取最多复用两次；后续滚动事件会清空缓存资格。

**不会**修改 `Element.prototype` 或 `HTMLElement.prototype`，也不会拦截所有滚动事件或网络请求。不过局部 getter 的返回值仍可能暂时变旧，不能视为无风险。

### 操作（DevTools Console）

安装伴随脚本后，在 ChatGPT 页面 F12 → Console：

```javascript
// 1. 观察模式：先确认它实际识别了滚动容器
ChatGPTRenderLitePhase4.setMode('observe');

// 2. 滚动后查看数据
ChatGPTRenderLitePhase4.status();

// 3. 仅在 observe 有真实命中时，尝试缓存实验
ChatGPTRenderLitePhase4.setMode('cache');

// 4. 恢复原始行为（保存 off 并刷新）
ChatGPTRenderLitePhase4.setMode('off');

// 紧急停止当前页面的运行时补丁（不更改下次打开的模式）
ChatGPTRenderLitePhase4.restore();
```

`setMode` 会保存所选模式并立即刷新当前页面，模式仅保存到该站点本地存储。禁用或卸载本脚本前，建议先将模式设置为 `off`，以免将来重新安装时意外恢复缓存模式。

### 判断是否命中目标

在 `status()` 里重点看：

- `patchedTargets`：0 表示没有对任何滚动元素安装局部 getter，**不能宣称已优化**。
- `nativeReads`：包装命中的原生高度读取次数。
- `cacheHits`：缓存实际复用次数。若为 0，缓存模式没有直接节省此路径的原生读取。
- `maxNativeReadMs`：单次原生 getter 包含测量开销的最大耗时，仅作线索，非精确 CPU 采样。

请按 **off → observe → cache** 做三组交互对照，每组至少三次，并同步导出 Performance trace 观察 `scroll → reconcileViewport → clientHeight` 是否真的缩短。历史 Trace 没有证明那个 `clientHeight` 就是本实验识别的滚动容器，所以命中率可能是 0。


## 开发

无需构建工具或外部运行时依赖，用户脚本入口：[`chatgpt-render-lite.user.js`](./chatgpt-render-lite.user.js)。

可选的基础逻辑测试（需要 Node.js）：

```bash
node --test tests/*.test.cjs
```

测试涵盖菜单开关、经典模式、Viewport Guard 近视口保护、滚动冷却、写入上限和 SPA 路由清理。**这些测试不代替在真实 ChatGPT 页面进行 Performance A/B 测试**。

## AI 生成声明

本项目的代码与文档由 OpenAI ChatGPT（GPT-6）辅助生成，尚未经过完整的真实页面性能验证。
