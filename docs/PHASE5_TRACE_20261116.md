# Phase 5 · 2026-11-16 DevTools Performance Trace（长对话上滚）

## 摘要

**已识别的主要瓶颈**是 `scrollend → 76629.efd173ce29.js / J → getBoundingClientRect() → UpdateLayoutTree + Layout`。这不是单纯的 Markdown Paint，而是 JS 回调触发的同步样式及布局刷新。

本次输入为用户上传的 DevTools TraceEvents（gzip，解压后约 117MB、293413 条事件），主文档 frame 的 PID=12764、主线程 TID=38932，窗口时长 26.961545s。没有使用先前 LoAF JSON 推测本次调用栈。

### 主线程数据

| 指标 | 结果 |
| --- | ---: |
| 主线程 `RunTask`（所有） | 8858 个、共 17.483s |
| `RunTask >50ms` | 73 个，含一次录制器启动 |
| Profiler 启动开销 | 896.322ms 的 RunTask，其中 `CpuProfiler::StartProfiling` 888.33ms |
| 排除上述启动后最长任务 | 388.955ms（14.547s） |
| `UpdateLayoutTree` | 1152 次，2918.33ms，最大 129.302ms |
| `Layout` | 258 次，2211.28ms，最大 79.688ms |
| Style + Layout | 5129.61ms；占记录窗口 19.03%（在 RunTask 内，不能重复加） |

每 3s 的主线程长任务数量为 `[4,15,9,13,6,5,11,3,7]`（第一桶含 Profiler 启动）。卡顿横跨整个滚动过程，不是一轮初始加载。

### scrollend 实证

| EventDispatch | 次数 | 分发耗时 | 其中 UpdateLayoutTree | 其中 Layout |
| --- | ---: | ---: | ---: | ---: |
| `scrollend` | **38** | **1702.33ms** | **1302.46ms** | **352.40ms** |
| `scroll` | 399 | 755.52ms | 74.88ms | 33.78ms |
| `wheel` | 221 | 240.65ms | 未单独归因 | 未单独归因 |

`scrollend` 分发中，强制 Style+Layout 的直接区间为 **1654.86ms**，约占事件总耗时 **97.2%**。38 次 `scrollend` 中有 **37 次**含 `ScheduleStyleRecalculation`；这些事件内共 **97** 次调度，其中 **96** 次同步栈首帧指向 `76629.efd173ce29.js / J`。随后在该调用路径下读取 `getBoundingClientRect()` 并触发刷新。

示例：录制 11.365s 处 `scrollend` 耗时 **166.191ms**，该事件内有 **123.478ms + 14.36ms** 的 UpdateLayoutTree，以及 **22.03ms + 3.77ms** 的 Layout。录制 4.350s 处 `scrollend` 耗时 **106.955ms**，内部有 **69.314ms Style + 36.391ms Layout**。

这是同一事件处理路径中“调度样式重新计算 → 同步几何测量 → 刷新”的直接证据，但仍**不能唯一锁定触发样式失效的具体 DOM 写入语句 / CSS 选择器**，也不能据此推断确有循环内反复写读。

### CPU Profile 交叉验证

主线程 CPU Profile 中 `getBoundingClientRect` 为叶节点的采样 **5019 个、timeDeltas 约 2788.1ms**，主要分为：

- `getBoundingClientRect ← J ← callback ← 76629…js`：约 **1641.6ms**。
- `getBoundingClientRect ← 149893…js ← 731863…js ← 226913…js`：约 **968.5ms**。

**采样估算不是纯 JS 自耗时**，可能包括样式/布局原生开销，不能再与 Style/Layout 累计相加。`149893… / 731863… / 226913…` 的第二条测量链也值得优化，不能把所有卡顿只归给 `scrollend`。

### 扩展和 DOM 风险

Trace 在约 13.199s 记录到扩展 `bootstrap-autofill-overlay.js` 的 `onScroll` 中有一次 **57.217ms** 的 `UpdateLayoutTree`。说明至少一个扩展也能触发高成本样式刷新，但不构成“卡顿全由扩展造成”的证据。

渲染进程 `UpdateCounters` 从约 35812 nodes / 24830 listeners 到 41385 nodes / 28238 listeners。统计含 6 个 document、可能含未回收节点，**不等于当前文档消息数**；不能据此证明没有虚拟列表或发生内存泄漏。

## 结论与 Phase 6 取舍

1. P0：对 `76629…js` 第 326 行 `J` / 第 342 行 callback（具体列需按版本）追踪 `ScheduleStyleRecalculation` 对应 DOM 写入，确认 `getBoundingClientRect` 是为何在 dirty 状态下测量。
2. P0：测试干净浏览器扩展配置；报告中特定 autofill overlay 单次造成了真实强制刷新。
3. P1：分析 `149893… → 731863… → 226913…` 组件更新期间的几何测量，使用 DevTools Call tree 和 Styles invalidation。
4. 不建议粗暴 patch `getBoundingClientRect`、`scrollend` 或私有压缩函数：可能破坏滚动锚点、弹层定位、消息跳转。
5. 重写 UI 时，若原消息树和滚动事件监听依然存在，**外观覆盖不会消除本次瓶颈**；需要真正卸载原渲染路径或走独立客户端，但后者不共享 Plus API 配额。

以上结论是这份单次 Trace 的诊断结论，尚不是任何优化已生效的证据。