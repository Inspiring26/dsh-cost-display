# DSH 峰谷费用显示插件

<p>
  <img src="https://raw.githubusercontent.com/Inspiring26/dsh-cost-display/main/icon.svg" width="76" height="76" alt="DeepSeek 峰谷费用图标">
</p>

[![npm](https://img.shields.io/npm/v/@weeh/dsh-cost-display?style=flat-square)](https://www.npmjs.com/package/@weeh/dsh-cost-display)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![CI](https://github.com/Inspiring26/dsh-cost-display/actions/workflows/ci.yml/badge.svg)](https://github.com/Inspiring26/dsh-cost-display/actions/workflows/ci.yml)

把 DeepSeek 的人民币峰谷费用直接接到 **DSH 原生用量显示**上：

- **每轮用量**：`用量 45.2K tok` → `用量 45.2K tok · ¥1.49`。
- **整体用量**：`45.2K tok · 缓存命中 80%` → `45.2K tok · 缓存命中 80% · ¥2.75`。
- 点开用量弹窗，原来的 token 明细全部保留，并新增费用行：
  - 每轮用量：费用、高峰费用 `¥1.20 · 3 次`、空闲费用 `¥0.29 · 1 次`
  - 整体用量：高峰费用、空闲费用（总费用已显示在底部用量胶囊上，卡内不再重复）
  - 未定价调用（如果有）
- 复制、点赞/点踩、分支、时间、用量按钮的位置和样式不变。

弹窗明细的横线下方还有一行 **今天费用 / 本月费用（全局）**，例如 `¥1.92 / ¥37.37`。它由插件宿主端汇总**整个 DSH 存储里的所有会话**（含子会话；fork 继承前缀不重复计费），按北京日历统计，和当前会话的「费用 / 高峰 / 空闲」是两套口径。

费用按 **DeepSeek 官方人民币峰谷价** 估算。高峰为北京时间周一至周五（不含中国法定节假日）**09:00–12:00、14:00–18:00**，其余时间（含周末、法定节假日全天）为空闲时段，空闲价约为高峰价的一半。

## 安装

从 npm 安装：

```sh
dsh plugin --profile web add @weeh/dsh-cost-display
```

从本地目录安装（开发时）：

```sh
dsh plugin --profile web add /absolute/path/to/dsh-cost-display
```

安装后刷新 DSH Web 页面；如果浏览器缓存了旧模块，用 `Cmd+Shift+R` / `Ctrl+Shift+R` 强制刷新。

> 全局今天/本月费用使用宿主端 `/api/cost.summary` 接口。新增或升级插件后需要**重启一次 `dsh web`**，只刷新页面不会加载新的宿主代码；重启后页面里的这一行由「需重启 DSH」变为金额。

在 **设置 → 插件 → 发现** 里添加社区索引，可以直接搜索安装：

```text
https://realoiyo.github.io/dsh-plugin-market/index.json
```

卸载：

```sh
dsh plugin --profile web remove @weeh/dsh-cost-display
```

## 价目（元 / 1M tokens）

| 模型 | 时段 | 缓存命中输入 | 未缓存输入 | 输出 |
| --- | --- | ---: | ---: | ---: |
| `deepseek-flash`（V4.1 Flash） | 空闲 | 0.02 | 1.00 | 4.00 |
| `deepseek-flash` | 高峰 | 0.04 | 2.00 | 8.00 |
| `deepseek-v4-pro` | 空闲 | 0.15 | 4.50 | 13.50 |
| `deepseek-v4-pro` | 高峰 | 0.30 | 9.00 | 27.00 |

来源：[DeepSeek 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。缓存写入已包含在未缓存输入里，不重复计价；推理 token 已包含在输出里。

## 实现方式

DSH 的用量弹窗内部没有暴露插件槽位，所以插件不能“在旁边再加一行”，而要接到原生用量上：

1. 找到 `conversation.chat.node` 里 key 为 `turn-tail` 的官方渲染项，以及 `conversation.composer.dock` 里 id 为 `usage` 的官方用量项。
2. **原地替换这两个渲染项的 `component`**，保留该项已声明的 `children`（`renderSlot` 来源）、`inject`（`performanceUsage`）和 `locale: "chat"`（`t` 来源）。
3. 替换后的组件是官方组件的同构副本：同样的 class、同样的按钮顺序、同样的复制/点赞/分支/用量位置，只在用量文字后追加 `·¥x`，并在 `<dl>` 里追加费用行。
4. 卸载插件时恢复原组件。

不修改 DSH 安装目录里的任何文件，也不改会话数据。因为依赖官方组件的内部 class 和槽位结构，**DSH 大版本升级后可能需要更新这个插件**；如果替换组件出错，DSH 的 `SlotErrorBoundary` 会兜底，不会把整个页面带崩。

数据来源是 DSH 自带的同源 `/api/session.export`：只读取根会话日志，不拉附件、不上传任何数据。日志里的请求开始时间决定峰谷；fork 子会话会跳过 `session/end-seed { inherited: true }` 之前的继承前缀，避免重复计费；失败/重试的 `assistant/attempt` 如果流里带 usage，也会单独计费。

## 文件

```
dsh-cost-plugin/
├── package.json          # Bundle 清单 + dsh.client 清单
├── cordis.patch.yml      # 插入 Host 半区
├── index.js              # Host 空实现（渲染全在浏览器半区）
├── client.js             # 构建产物：自包含的浏览器模块
├── icon.svg              # 插件图标（时钟 + ¥）
├── assets/icon-180.png   # 商店/精选列表用位图
├── src/
│   ├── cost-core.js      # 价目、峰谷/节假日、会话日志折叠、ZIP 提取
│   ├── chat-bridge.js    # 原生用量/操作行的同构副本 + 费用追加
│   └── client.js         # 浏览器模块源码（含两个内联占位）
├── build.mjs             # 把核心和 bridge 内联进 client.js
├── locale/{zh,en}.json   # Plugin Manager 显示用的标题/描述
├── market/               # 自建 DSH 市场索引 + awesome 列表条目
├── scripts/              # 发布准备脚本
└── test/                 # 核心、加载、React 渲染测试
```

## 开发

```sh
pnpm install
pnpm test
pnpm build
```

`pnpm test` 运行费用核心、bundle 加载和 React 服务端渲染测试；正式运行使用 DSH 浏览器里已有的 React，不会加载额外的运行时依赖。

## 发布

- **GitHub**：把仓库推到 `https://github.com/Inspiring26/dsh-cost-display`；
- **npm**：`npm publish --access public`；
- **DSH 社区市场**：发布 npm 包后，[REALOIYO/dsh-plugin-market](https://github.com/REALOIYO/dsh-plugin-market) 会按 `keywords:dsh-plugin` + `dsh.bundle` 自动收录；
- **awesome-dsh-plugin**：把 `market/awesome-dsh-plugin.yml` 作为 `data/plugins/Inspiring26__dsh-cost-display.yml` 提 PR。

完整步骤见 [PUBLISHING.md](https://github.com/Inspiring26/dsh-cost-display/blob/main/PUBLISHING.md)。

## 边界

- 这是**估算**，不是账单；以 DeepSeek 平台实际扣费为准。
- 内置价目是当前官方价。历史会话也按当前价估算，**没有回溯 2026-09-10 之前的 Flash 旧价**，也没有处理 `deepseek-v4-pro` 的临时转发价；需要严格历史账单时请以官方账单为准。
- 只统计会话日志里**上报了 usage** 的调用；标题生成、网页搜索等没有 usage 的辅助调用不计入。
- 默认只算当前会话，**不含子代理会话**；子代理有独立会话，可在各自会话里查看。
- 未收录的模型显示「未定价」，不会按 0 元假装免费。
- 工作详情模式为 `compact` 时，每轮用量本身是隐藏的（官方行为），插件不会强行显示；整体用量在 compact 下只显示缓存命中 + 费用。

## License

[MIT](./LICENSE)
