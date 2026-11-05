# 发布指南：GitHub、npm 与 DSH 插件市场

这份指南把 `dsh-cost-plugin` 从本地开发目录变成：

1. 一个独立的 GitHub 仓库；
2. 一个可安装的 npm 包；
3. 一个能被 DSH「发现」页和社区市场收录的插件。

> 下面用 `Inspiring26` 表示你的 GitHub 用户名，`inspiring26` 表示你的 npm scope（通常和 GitHub 用户名相同）。发布前先决定这两个名字。

## 0. 准备

- Node.js 22+、pnpm（或 npm）；
- GitHub 账号；
- npm 账号（[npmjs.com](https://www.npmjs.com/)）；scoped 包需要先创建 scope（发布时 npm 会自动按 scope 归属校验）。
- 本地开发包带 `private: true` 和 `@local/` 前缀，**不要直接发布它**；下面的脚本会生成一个改好名字的 `release/` 目录。

## 1. 生成发布目录

在插件目录执行：

```bash
cd "/Users/huangyong/Downloads/dsh/dsh改造/dsh-cost-plugin"

node scripts/prepare-release.mjs \
  --name @inspiring26/dsh-cost-display \
  --repo https://github.com/Inspiring26/dsh-cost-display \
  --author "你的名字"
```

它会生成 `release/`，并完成这些事：

- `package.json`：改名为 `@inspiring26/dsh-cost-display`，去掉 `private`，补 `repository`、`homepage`、`bugs`、`author`、`license`、`keywords`、`publishConfig`、`engines.dsh`；
- `client.js` 与 `src/client.js`：把模块 id 里的本地前缀改成新包名；
- `cordis.patch.yml`：把 Host 行名改成新包名；
- `LICENSE`：写入你的名字；
- `market/index.json`：生成一份合法的 **DSH 插件市场索引格式 1** 文件；
- `market/awesome-dsh-plugin.yml`：生成提交给 `awesome-dsh-plugin` 的单文件条目；
- 复制 `README.md`、`PUBLISHING.md`、`.github/`、`test/`、`assets/icon-180.png` 等。

生成后检查：

```bash
cd release
cat package.json | head -40
cat market/index.json
pnpm install
pnpm test
pnpm build
```

`pnpm build` 后 `git diff` 应该为空（`client.js` 已提交）。

## 2. 创建 GitHub 仓库

先在 GitHub 网页创建一个空仓库，名字建议 `dsh-cost-display`，**不要**勾选 README / .gitignore / license（本地已有）。

```bash
cd release
git init
git add -A
git commit -m "feat: dsh-cost-display 0.1.0"
git branch -M main
git remote add origin https://github.com/Inspiring26/dsh-cost-display.git
git push -u origin main
```

或者用 GitHub CLI：

```bash
gh repo create Inspiring26/dsh-cost-display --public --source=. --remote=origin --push
```

接着在 GitHub 仓库页面：

- **About** 里填一句描述，加上 topics：`dsh`、`dsh-plugin`、`deepseek-harness`、`cost`、`usage`；
- **Settings → Pages** 可以稍后开启（用于自建市场索引，见第 5 节）；
- 创建一个 **Release**，tag 用 `v0.1.0`，附上 `dsh-cost-display-0.1.0.tgz`（可选，但推荐）。

## 3. 发布到 npm

> 发布前确认你已经在 npm 登录，并且 `@inspiring26` 是你的 scope。

```bash
cd release
npm login
npm publish --access public
```

如果这台机器的 npm 缓存目录有 root 权限文件（之前 `npm view` 报过 `EPERM ... ~/.npm/_cacache`），可以先用一个本地缓存目录发布，避免动系统目录：

```bash
cd release
npm_config_cache="$PWD/.npm-cache" npm publish --access public --registry https://registry.npmjs.org/
```

或者修复缓存权限后正常发布：

```bash
sudo chown -R "$(id -u):$(id -g)" ~/.npm
```

发布成功后验证：

```bash
npm view @inspiring26/dsh-cost-display version
npm view @inspiring26/dsh-cost-display keywords
```

`keywords` 里必须能看到 `dsh-plugin`，`package.json` 里必须有：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web" }
}
```

这两点是市场收录的硬条件。

## 4. 发布到 DSH 相关市场

### 4.1 社区索引（自动收录）

社区维护的 DSH 插件索引：

- 索引地址：<https://realoiyo.github.io/dsh-plugin-market/index.json>
- 项目：<https://github.com/REALOIYO/dsh-plugin-market>

它的收录规则是**自动发现 npm 包**：

1. 用 npm 搜索关键词 `keywords:dsh-plugin`；
2. 拉取每个候选包的 `package.json`；
3. **只保留声明了 `dsh.bundle` 的包**。

所以只要 npm 包带了 `dsh-plugin` 关键词和 `dsh.bundle` 声明，下一次索引重建（每 6 小时，UTC 0/6/12/18）就会自动出现，**不需要提 PR**。

在 DSH 里添加这个市场：

1. 打开 **设置 → 插件 → 发现**；
2. 点 **添加索引源**；
3. 粘贴 `https://realoiyo.github.io/dsh-plugin-market/index.json`；
4. 在 Discover 里搜索 `dsh-cost-display` 或「峰谷」。

> DSH 拒绝重定向，必须用上面的最终地址；索引在 DSH 进程内有约 10 分钟缓存。

### 4.2 awesome-dsh-plugin（人工精选，建议提 PR）

项目：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>

它是一份人工精选列表，投稿方式是**只加一个 YAML 文件**：

```text
data/plugins/Inspiring26__dsh-cost-display.yml
```

内容用 `release/market/awesome-dsh-plugin.yml`，大致是：

```yaml
url: https://github.com/Inspiring26/dsh-cost-display
name: Inspiring26/dsh-cost-display
category: usage
description:
  en: Appends DeepSeek peak/off-peak cost estimates to the native per-turn and session usage displays.
  zh: 在原生每轮用量和整体用量文字后追加 DeepSeek 峰谷费用，点开可看高峰/空闲拆分。
icon: https://raw.githubusercontent.com/Inspiring26/dsh-cost-display/main/assets/icon-180.png
```

提交 PR 前确认：

- 仓库已经创建满 **1 天**（CI 会检查）；
- 仓库有 `dsh-plugin` topic；
- `package.json` 有 `dsh.bundle`；
- 描述只写功能，不写营销词；
- 只改自己新增的 `data/plugins/...yml`，不要手工改 README（README 由脚本生成）。

### 4.3 自建市场索引（可选，但完全可控）

`release/market/index.json` 已经是一份合法的格式 1 索引。托管方式二选一：

**GitHub Pages**：

1. 仓库 **Settings → Pages** → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`；
2. 等 Pages 构建完成；
3. 索引地址：`https://Inspiring26.github.io/dsh-cost-display/market/index.json`；
4. 在 DSH **设置 → 插件 → 发现 → 添加索引源** 里粘贴这个地址。

**raw.githubusercontent.com**：

```text
https://raw.githubusercontent.com/Inspiring26/dsh-cost-display/main/market/index.json
```

raw 地址是最终地址，不会重定向；但 GitHub Pages 更像一个“市场主页”，推荐 Pages。

索引里的 `icon` 用的是仓库根目录的 `icon.svg` 绝对地址；如果你改了默认分支名（不是 `main`），记得同步改 `market/index.json` 里的 URL。

### 4.4 其他目录（可选）

- [dshbase.com](https://dshbase.com/) 等第三方目录：按其站点说明提交仓库/npm 包；
- 其他 DSH 社区群/论坛：直接发 GitHub Release 和 npm 链接。

## 5. 版本升级流程

1. 改代码；
2. `pnpm test && pnpm build`；
3. 提升 `package.json` 的 `version`（例如 `0.1.1`）；
4. 更新 `market/index.json` 的 `versions`（版本号、`publishTimestamp`）；
5. 重新生成发布目录：

```bash
node scripts/prepare-release.mjs \
  --name @inspiring26/dsh-cost-display \
  --repo https://github.com/Inspiring26/dsh-cost-display \
  --author "你的名字" --version 0.1.1 --force
```

6. `cd release && npm publish --access public`；
7. GitHub 打 tag `v0.1.1` 并创建 Release。

> `prepack` 会在 npm 打包前自动运行 `node build.mjs`，但建议提交前也跑一次，保持 `client.js` 与 `src/` 同步。

## 6. 注意事项

- **兼容范围**：`package.json` 的 `engines.dsh` 目前是 `>=0.2.1-rc.4 <0.3.0`。插件覆盖了 DSH 0.2.1-rc.4 的 `turn-tail` / `usage` 槽位组件，DSH 升级到 0.3 及以上时请先验证再放宽范围。
- **npm scope**：`@inspiring26` 必须是你的 npm scope；第一次发布前在 npm 上创建 scope（通常与用户名相同）。
- **不要发布 `@local/...`**：本地开发包带 `private: true`，直接 `npm publish` 会失败；用 `release/`。
- **不要提交 `node_modules`**：`.gitignore` 已处理；`release/` 里重新 `pnpm install`。
- **测试依赖**：`pnpm install` 会装 `react`、`react-dom`、`fflate` 作为 devDependencies；正式运行不需要它们。
- **市场索引校验**：如果手改 `market/index.json`，可以用 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 校验；任何一条违规都会让整份索引被 DSH 拒绝。

## 7. 相关链接

- DSH 插件市场索引格式说明（官方仓库中的 Agent Note）：<https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-10-02-plugin-market-index-format.zh.md>
- 社区索引：<https://github.com/REALOIYO/dsh-plugin-market>
- 精选列表：<https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
- DSH 仓库：<https://github.com/deepseek-ai/deepseek-harness>
