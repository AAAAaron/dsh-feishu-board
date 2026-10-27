# 发布到 DSH 插件市场：现状与步骤

先给结论：**DSH 没有官方托管的插件市场**。官方只提供"读索引"的 Host 服务 + Discover UI，
索引源（一个 `index.json` URL）由每个用户自己添加；真正的社区索引由第三方维护。

所以"发布"分成三层，可以分别做：

| 层 | 做什么 | 谁审核 | 现状 |
|---|---|---|---|
| 1. GitHub 仓库 | 别人能 `git+https://…#<commit>` 直接装 | 无 | ✅ 已发布 |
| 2. npm 包 | `npm publish`，索引条目才能写 `source.type = "npm"` | npm 注册 | ✅ 已发布 `dsh-feishu-board@0.2.0` |
| 3. 社区索引 | 向 awesome-dsh-plugin 提 PR；合并后进 `dsh-plugin-catalog` → jsDelivr 索引 | 人工 | ⬜ 待提 PR（仓库满 1 天后） |

## 1. GitHub 直装（已可用）

```sh
dsh plugin --profile web add "git+https://github.com/AAAAaron/dsh-feishu-board#<40位commit>"
```

`dsh` 会先用 `git ls-remote` 校验，装完检查 `engines.dsh`，失败自动回滚。用 commit 而不是分支名，
保证别人装到的就是你验证过的版本。

## 2. npm 发布

已发布：**`dsh-feishu-board@0.2.0`**（https://www.npmjs.com/package/dsh-feishu-board ），
发布账号 `aarontxc007`，`latest` 指向 0.2.0。

```sh
npm publish --access public
```

发布到 npm 11.16+ 时当前走**暂存发布（staged publishing）**：`npm publish` 返回 202，
注册表先出现一个 `0.0.0-stage` 占位版本，真实的 0.2.0 在约 1 分钟内完成处理、`latest` 切过去。
占位版本留在版本列表里，属正常，不影响安装。

认证：账号开了 2FA，`npm publish` 需要 OTP 或**带 Bypass 2FA 的 granular token**。本机已在
`~/.npmrc`（权限 600）存这种 token，直接 `npm publish` 即可。

发布前确认 `package.json`：

- `"private": true` 必须没有（本仓库已移除）；
- `name` / `version` 唯一且合法；
- `files` 白名单只带运行需要的文件（本仓库已配好）；
- `license`、`repository`、`keywords` 齐备。

## 3. 进社区索引

事实上的社区索引（format 1）：

- `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`
- 备用：`https://awesome-dsh-plugin.com/index.json`、`https://dshmarket.com/index.json`

用户在自己 DSH 里打开 Plugins → Discover → **Add index source**，填入上面的 URL 就能搜插件。

索引条目（官方 validator 实测可过的最小结构）：

```json
{
  "format": 1,
  "title": { "en": "Feishu Board", "zh": "飞书公告板" },
  "plugins": [
    {
      "name": "dsh-feishu-board",
      "title": { "en": "Feishu Board", "zh": "飞书公告板" },
      "versions": [
        {
          "version": "0.2.0",
          "publishTimestamp": 1793000000,
          "source": { "type": "npm" },
          "engines": { "dsh": ">=0.2.1-rc.2" }
        }
      ]
    }
  ]
}
```

Git 渠道把 `source` 换成：

```json
{ "type": "git", "url": "https://github.com/AAAAaron/dsh-feishu-board", "commit": "<40位小写hex>" }
```

注意：社区索引**只收录已发布到 npm 的插件**；只有 GitHub 的条目可以留在 awesome 列表里（附安装命令），
但不进 `index.json`。

提交入口：`https://github.com/awesome-dsh-plugin/awesome-dsh-plugin`。**不要改 README**（由脚本生成），
PR 只加一个文件 `data/plugins/AAAAaron__dsh-feishu-board.yml`，内容见本仓库 `docs/awesome-entry.yml`。
收录要求（`contributing.md` 原文口径）：

- 仓库 `package.json` 声明 `dsh.bundle`（本仓库已有 `cordis.patch.yml`）；
- 真实可用的代码；
- **仓库创建满 1 天**（CI 自动检查，PR 时现建仓会被拒）；
- 仓库带 `dsh-plugin` topic；
- 描述只写功能、必须与代码一致（会给"数字/API 名"对账）；
- 分类贴近实际用途，选偏了维护者会改，不因此打回。

失修会被移除；上榜**不等于**安全审查。

## 4. 完全自主的索引（不依赖别人合并）

把自己的 `index.json` 作为 npm 包里的一个文件发布（照 `dsh-plugin-catalog` 的做法），
或者放到 GitHub Pages，然后把该 URL 告诉使用者，让他们在 Discover 里添加。

## 现在的状态

- 第 1 层 ✅：仓库 `AAAAaron/dsh-feishu-board` 已公开，带 `dsh-plugin` topic；
- 第 2 层 ✅：npm 已发布 0.2.0，本机 `~/.npmrc` 存了带 Bypass 2FA 的 granular token；
- 第 3 层 ⬜：等仓库满 1 天（2026-10-28 13:25Z 之后）向 awesome-dsh-plugin 提 PR，
  只加 `data/plugins/AAAAaron__dsh-feishu-board.yml` 一个文件，内容见 `docs/awesome-entry.yml`。

## 安装命令（给使用者）

```sh
dsh plugin --profile web add dsh-feishu-board@0.2.0
```
