# Phase 6.1：原版 ChatGPT 消息渲染桥接实验

> 高风险实验，默认完全关闭。仅在不重要的长对话中测试，不能作为日常聊天界面。

本实验沿用 Phase 6 虚拟消息列表，在原版 chatgpt.com 里做三个阶段的验证：识别现有消息 DOM、显示独立只读镜像、经过确认后将原消息列表暂时移出可见布局。Plus、模型选择、输入框、侧边栏、服务器连接仍由原版网页提供。

**这不是 React 真正卸载或替换：** takeover 仅对经过验证的消息根节点设置 display:none!important，同时显示自定义虚拟列表。原 React 仍可能运行，只有真实 Performance Trace 才能证明同步 Style/Layout 或滚动事件开销减少。

## 安装和操作

[从实验分支安装独立 Tampermonkey 脚本](https://raw.githubusercontent.com/MillioApaski/ChatGPT-Render-Lite/feature/phase6-native-render-bridge/chatgpt-native-render-bridge.user.js)

关闭其他 Render Lite / Phase4 脚本后，刷新 chatgpt.com，进入普通长对话。在 Tampermonkey 菜单依次尝试：

### v0.3.0：根据真实页面反馈修正识别

用户的 v0.2.0 `probe()` 显示：旧选择器全部为 0，`main` 含 680 个元素，`.prose` 类匹配 3 个、`whitespace-pre-wrap` 类匹配 2 个，自动猜到一个仅有 **2 行**的候选。这不能证明仅加载两条消息，更可能是误将布局容器当作消息根节点。

- **自动推断少于 5 个独立正文分支/兄弟行时拒绝候选**，因此这一数据形态不会让接管继续。数字 5 是安全下限，不是声称 5 个就一定能代表真正消息。
- 新增 **「Phase6：匿名 DOM 层级报告」**。通过 `ChatGPTRenderLiteBridge.structure()` 获取 `main` 下结构概要：路径序号、节点标签、直接子节点数量、各子标签数量、部分属性**名称**。不包含聊天文本、HTML 内容、类名、属性值、ID、URL 或 React props。
- 新增点选结构报告：用「点击消息定位容器」点击**真正的一条历史消息正文**后，控制台会先输出 `[RL Bridge] 点选结构`，给出该位置的祖先及兄弟数。即使找不到可靠消息容器，也可以利用这份匿名信息修复识别器。
- 在真实页面结构确认前 **只运行扫描/点选，不要执行 takeover**。页面快照里仅有 2 条候选消息时，`start('preview')` 也会拒绝，而不是错误显示两个大块。

如需要反馈，将 `ChatGPTRenderLiteBridge.structure()` 的输出与 `[RL Bridge] 点选结构` 的 `chain` 粘贴回来即可。因输出不含正文，不必分享私人对话内容。



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
ChatGPTRenderLiteBridge.structure() // v0.3: 无聊天文字的层级报告
ChatGPTRenderLiteBridge.pick() // 然后点击一条历史消息，Esc 取消
ChatGPTRenderLiteBridge.fiberProbe()
ChatGPTRenderLiteBridge.start('preview')
ChatGPTRenderLiteBridge.start('takeover') // 会弹出二次确认
ChatGPTRenderLiteBridge.status()
ChatGPTRenderLiteBridge.restore()
ChatGPTRenderLiteBridge.setSelector('main article') // 仅作示例
~~~

## v0.4.0：新版 ChatGPT DIL DOM 实测标记

根据真实聊天消息的匿名 DOM 祖先链，当前页面出现了如下标记：

| 属性 | 用途（依照所处层级） |
| --- | --- |
| `data-rail-chat-transcript` | 聊天记录内容根 |
| `data-thread-frame-scrollbar` | 当前滚动框架 |
| `data-turn-key` | 某轮对话的 key |
| `data-talvt-turn-state` | 当前轮的状态容器 |
| `data-response-body` | 助手回复正文 |
| `data-dil-response` / `data-dil-message-id` | 当前 DIL 消息正文结构 |

重要：`data-talvt-turn-state` 的存在**不能证明**已实现消息虚拟化；必须观察向上滚动时同时挂载的 key 数量、已见 key 总数、节点替换情况。

脚本升级后，在原版聊天页面的控制台执行：

```js
ChatGPTRenderLiteBridge.nativeOverview()       // 匿名 DIL 节点计数
await ChatGPTRenderLiteBridge.monitorTurns(12000) // 执行后在 12 秒内手动向上滚动
```

第一份结果只包含属性存在性和数量；第二份结果每约 400ms 采样，汇总 `minMounted`、`maxMounted`、`uniqueTurnKeys`、`addedKeys`、`removedKeys`。内部比较实际 `data-turn-key` 值，但**不打印 key、消息 ID、文本、URL 或 React props**。

如果 `uniqueTurnKeys` 明显大于 `maxMounted`，且 `removedKeys>0`，支持聊天列表按需替换或卸载 DOM 的假说，但仍不证明历史已经全部加载，更不能单凭此判断 React 组件计算开销是否消失；应结合滚动 Performance Trace。

### 接管限制

`data-rail-chat-transcript` 存在时，v0.4.0 的 `start('preview')` 可以只读镜像**当前已经挂载**的 `data-turn-key` 节点，即使只有一条，状态中的 `messages` 也仅代表“当前 DOM 中可见/已挂载”，不是完整对话轮数。**`start('takeover')` 明确拒绝执行**，避免只镜像部分消息后隐藏掉原生历史浏览能力。

原网页有自己的滚动策略和 DIL 渲染组件。下一阶段如果证明原生已经在做 DOM 虚拟化，应优先优化消息测量/滚动锚点，而不是再做第二层虚拟列表。

## v0.4.0：真实长对话按需挂载证据（2026-11-16）

来自用户原版 ChatGPT 网页中的匿名检测：

| 指标 | 结果 |
| --- | ---: |
| transcript 根 | 1 |
| 初始已挂载 `data-turn-key` | 1 |
| 初始 DIL message / response body / turn state | 均为 1 |
| 12 秒采样数 | 30 |
| 最少 / 最多同时挂载的 turn | **1 / 5** |
| 采样过程中出现过的不同 turn key | **9** |
| addedKeys / removedKeys | **9 / 7** |

时间线摘录：

- **4.235 秒**：2 个同时挂载的 turn，出现 1 个 key、消失 1 个 key。
- **5.579 秒**：3 个同时挂载的 turn，出现 2 个、消失 1 个。
- **10.523 秒**：5 个同时挂载的 turn，出现 4 个新 key。
- **12.013 秒**：2 个仍挂载。

### 可以确认什么？

滚动时 `data-turn-key` 集合持续变化，且同时挂载 turn 数量保持很小，**强有力地支持原生 ChatGPT 已经按需挂载/回收消息 DOM**。在此情境下，再加一层独立“消息虚拟列表”没有明确价值，反而可能重复实现、干扰原生滚动与恢复。

### 仍不能确认什么？

- 没有证明 React Fiber 卸载，或 React 计算工作量变小。
- **400ms 抽样会漏掉短暂出现/消失的消息**，`addedKeys` 包含初始化时已有的首个 key，不等于页面整个时间段实际创建的 DOM 数量。
- 这 9 个 key 是期间观察到的不同标记，不是完整会话消息数。
- 没有测出 Style/Layout、LoAF 或 INP；不能把这次统计转化为性能提升百分比。

### 调整技术路线：直接优化原有滚动测量与单条复杂消息

旧版 `chatgpt-render-lite.user.js` 和 `chatgpt-geometry-cache.user.js` 使用 `[data-testid^="conversation-turn-"]`，当前用户页面该选择器 **0 命中**。因此以这个选择器为准的 Phase 3/4 逻辑对当前 DOM 很可能无效。Phase 4 的缓存目标是滚动容器的 `clientHeight`，而以前的 Trace 主要瓶颈是不同路径触发的 **`getBoundingClientRect()` 与强制同步 Style/Layout**，二者并不等价。

后续工作应按以下顺序验证：

1. **分离真实瓶颈**：只加载原网页，其他 Render Lite 脚本关闭；同一长对话、相同滚动操作，再录 Performance Trace，确认 `scrollend` 的受迫布局开销及 DIL 子树更新是否仍主导。
2. **定位实际几何测量对象**：明确 scrollend 时读取的是滚动容器、turn 的外壳，还是 DIL 正文内部组件。不能对所有 `getBoundingClientRect` 全局缓存，因为其计算受样式、位置、视口与动态内容影响。
3. **做独立、默认关闭的局部实验**：如果成本集中在单条很长的 DIL 回复，验证针对离屏 DIL 块的样式隔离；如果成本集中在原生滚动管理，探索与现有测量逻辑兼容的只读高度缓存/合并更新。每一种模式都需要独立 A/B Trace，证明总 Style+Layout、scrollend、长任务真实下降。
4. **失败时不改原网页**：永不默认隐藏真实 transcript；不能破坏搜索定位、滚动锚点、代码块、引用与流式生成。

目前 PR #5 保留为**原版 DIL 结构的诊断与预览实验**，原生 DIL 页的 takeover 被明确阻止。不能宣称“已经替换 React 渲染器”或“已经修复卡顿”。

## Phase 6.2：`getBoundingClientRect` 接收对象诊断（独立脚本）

已有的 Phase 5 DevTools Trace 指向了 `scrollend → getBoundingClientRect → UpdateLayoutTree / Layout`，但 **Trace 缺少读取该几何数据时的具体 DOM 元素**。目标分类未确定前，不能直接在原生原型或某个全局事件上加缓存/拦截。

新的单独测试脚本：[`chatgpt-geometry-target-probe.user.js`](../chatgpt-geometry-target-probe.user.js)。

它**不自动工作**；必须先在 Console 主动开启测试。建议暂停其他 Render Lite 优化脚本、不要同时开启 DIL takeover。

```js
ChatGPTRenderLiteGeometryProbe.status()
ChatGPTRenderLiteGeometryProbe.capture(10000) // 手动滚动 10 秒，到时自动恢复
ChatGPTRenderLiteGeometryProbe.status().last
ChatGPTRenderLiteGeometryProbe.restore()      // 随时手动提前恢复
```

探针临时包装 `Element.prototype.getBoundingClientRect`（在 `MAIN_WORLD`），保证返回**原始浏览器 DOMRect**，从不提供缓存或伪造高度；自动到时、切换会话、隐藏标签页或关闭页面时恢复原始 descriptor，若另一个插件在测量期间再替换此方法则不会覆盖对方。此探针有风险，适合在不重要的对话临时运行；安装并不代表已开启。

返回的 `groups` 只有以下信息：

- `category`: 几何测量对象位于 `scroll-host`、`turn-root`、`dil-response-root`、`inside-dil`、`inside-response`、`inside-turn`、`inside-transcript`、`outside-transcript` 等哪个 DOM 结构下；
- `afterScrollend`: 是否发生在 `scrollend` 事件后约 200ms 的窗口里；**仅为时间邻近关系，不证明该读取属于 scrollend 回调**；
- `calls`、`nativeMs`、`maxNativeMs`: 原生调用的次数与测得耗时；被迫 Style/Layout 可能包含在原生耗时中，但不会直接拆分出布局引擎耗时。

不会打印消息内容、标识值、URL、React props 或几何坐标。最多统计 **50,000 次调用**、最长运行 **15 秒**。**全局包装本身有性能扰动，不能将这次结果用于宣称优化前后的性能百分比**，只用来确认“哪个 DOM 类型被读取”。

如果输出显示高成本主要集中在 DIL 回复内部，可以再做**单条复杂消息的局部离屏隔离**实验；如果集中在 turn 根或滚动容器，需继续审查原生滚动锚点/测高机制。选定实验后，再在探针完全关闭的情况下采集新的 DevTools Trace 进行 A/B。

## Phase 6.3：离屏 DIL 文本块隔离 A/B 实验

### 本次真实几何探针结果

用户 10 秒原网页测试，`getBoundingClientRect()` 共 **1,554 次**，合计原生方法耗时约 **1,057.7ms**，单次最高 **130ms**，同期 `scrollend` 为 **17 次**。主要分组：

| 元素类别 / 时间窗口 | 调用次数 | 累计耗时（ms） |
| --- | ---: | ---: |
| `turn-root` / 200ms 窗口外 | 5 | 285.3 |
| `scroll-host` / 200ms 窗口内 | 223 | 272.0 |
| `inside-dil` / 窗口内 | 23 | 170.8 |
| `inside-turn` / 窗口内 | 11 | 112.0 |
| `inside-turn` / 窗口外 | 10 | 112.0 |
| `dil-response-root` / 窗口外 | 13 | 98.7 |

这 **285 次调用贡献了约 99.3% 的采样累计耗时**；其余多数几何查询代价很小。读到 DOMRect 时的强制布局和调用本身的时间无法单靠该探针拆开，且“滚动后 200ms”仅表示时间相关，不足以归因到某一回调。**不应直接全局缓存 `getBoundingClientRect`**，特别是原生列表已显示出动态挂载消息的行为。

### 新增可回退实验

独立脚本：[`chatgpt-dil-containment-lab.user.js`](../chatgpt-dil-containment-lab.user.js)。它默认关闭，不监听滚动、不创建 DOM、也不添加 CSS。仅在用户明确调用 `enable()` 后尝试：

1. 在当前原生 transcript 中找到有至少 8 个直接文本块的 `[data-dil-response]`，仅考虑其直接子元素 `p`、`pre`、`blockquote`、`ul`、`ol`。
2. 等待约 500ms，确认滚动位置没有改变，再只对 **距离实际视口至少 300px**、已测量高度至少 36px、没有交互式子元素且未处于焦点内的文本块设置 `content-visibility:auto` 和 `contain-intrinsic-block-size:auto <测得高度>px`。
3. 绝不修改 `[data-turn-key]`、`[data-rail-chat-transcript]`、滚动容器或主输入框；无论嵌套层次怎样都不对它们做 display:none。
4. 启用后立即核对 scrollHeight：绝对变化超过 80px 或相对变化超过 1%（取更宽容的阈值）就撤销。检测到被修改块内容更新、原消息卸载、切换路由、标签页隐藏或关闭，也会回退。
5. 只在当前挂载的消息片段中工作；不尝试保持跨会话的自定义列表。

Chrome/MDN 明确指出 `content-visibility:auto` 配合 `contain-intrinsic-size` 能跳过离屏内部布局，但占位尺寸不合适时会导致滚动跳动，因此实测回退校验和可一键关闭是必需的：

- <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility>
- <https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/contain-intrinsic-block-size>

### v0.1.1 状态时序修正

用户首次在真实 ChatGPT 页面启用时，返回 `active:true`、`pending:true`、`appliedBlocks:7`、`beforeHeight:11711`、`afterHeight:11711`。这表示 7 个文本块已成功应用且页面总体 scrollHeight **初始变化为 0px**。但 `pending:true` 是 `enable()` 在 `finally` 清除 pending 前过早构造返回状态快照导致的报告错误，而不是有第二轮优化仍在等待。v0.1.1 改为完成清理后才返回最终状态，并在 Chromium E2E 中断言 `pending:false`。

此结果**不等于真实流畅度改善**。需进一步录制关闭探针的原生 Performance Trace 对照；仅当前时刻 scrollHeight 相同也不能保证滚动过程中绝不跳变。

### 使用与对照

1. **关闭旧 Render Lite 优化、Phase 4 Geometry Cache 和 Phase 6.2 Geometry Probe**；保持 v0.4.0 Bridge 为 off。打开同一条长对话。
2. **关闭本实验**时，在 DevTools Performance 录制 10–15 秒向上/向下滚动，重复至少 3 次；记录 `scrollend`、`getBoundingClientRect`、Style/Layout、Long Tasks。
3. 安装新脚本并刷新页面。滚动到一条有大量段落的历史回复中间，停止滚动，然后执行：

```js
await ChatGPTRenderLiteDILContainment.enable()
ChatGPTRenderLiteDILContainment.status()
```

启用结果应显示 `active:true` 和 `appliedBlocks>=4`。如果报告 `not-enough-measured-offscreen-blocks`，说明这次没有足够符合条件的离屏复杂块，没有应用优化，**不能拿来作为 B 组**。
4. 保持启用状态，正常滚动并录制同样的 Performance Trace，重复 3 次。实验可能因原生列表换页或内容更新而自动关闭，记录 `lastReason`。如果关闭或滚动跳动，该轮 B 组不应宣称有效。
5. 手动恢复：

```js
ChatGPTRenderLiteDILContainment.disable()
```

**验收标准**：相似的滚动路径下，B 组的总 Style/Layout、长任务和明显卡顿比 A 组持续下降，并且没有造成滚动跳跃、搜索失效、引用与代码块交互破坏。测试期间发现交互异常，立即关闭并停止该方案。内容少、频繁流式更新或浏览器本身已经充分优化的页面，隔离可能**没有收益甚至更慢**。

此实验使用原有网页与 Plus 登录，不拦截请求、不替换 React、不缓存几何结果，也不是自动的最终优化。

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
