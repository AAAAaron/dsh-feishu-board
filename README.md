# dsh-feishu-board —— 飞书公告板（DSH 宿主插件）

[![npm](https://img.shields.io/npm/v/dsh-feishu-board.svg)](https://www.npmjs.com/package/dsh-feishu-board)
[![license](https://img.shields.io/npm/l/dsh-feishu-board.svg)](LICENSE)

**一句话**：DSH 里任何会话向你提问（`ask_user_question`），问题和选项会推到你的飞书私聊；
你在飞书里回复的**原文**，会被原样当作答案送回那个会话，它接着往下跑。

适合"人不在电脑前、手机上回一句就行"的场景。宿主侧常驻，与具体会话无关：关对话、断手机
都不影响；`dsh web` 重启后自动重新加载。

```
任一会话 ask_user_question
        │
        ▼
[本插件] 全局 user-questions/request（prepend，与 Web GUI 竞争，先答先算）
        ├─ 写 board/questions.jsonl
        ├─ lark-cli im +messages-send → 你的飞书私聊（bot 身份，无 LLM）
        └─ 等答案（turn 被 abort 时同步退出；Web 先答则作废本条）
        │
        ▼
[本插件] 每 10s：lark-cli im +chat-messages-list 读私聊历史
        └─ 你的回复 → answers.jsonl → 解析成选项/自由文本 → 返回瀑布
        │
        ▼
原会话继续（Web GUI 上同步显示「已回答」）
```

## 前置条件

- DSH `>= 0.2.1-rc.2`（宿主插件随 `dsh web` 常驻）。
- 飞书官方 [lark-cli](https://github.com/larksuite/cli)，且已用**bot 身份**登录：
  `lark-cli auth status` 显示 bot ready。
- bot 能给你发私聊（`im:message.p2p_msg:readonly` 读 + 发消息权限）。
- Node.js `>= 20`。

## 安装

```sh
# 1) 装到 profile（三选一：npm / Git / 本地目录）
dsh plugin --profile web add dsh-feishu-board@0.2.2
#   或：dsh plugin --profile web add "git+https://github.com/AAAAaron/dsh-feishu-board#<40位commit>"
#   或：dsh plugin --profile web add "link:/path/to/dsh-feishu-board"

# 2) 确认 profiles/web/package.json 的 dsh.profile.bundles 里有 "dsh-feishu-board"
#    （dsh plugin add 不一定自动写这一条）

# 3) 配好 chatId / userOpenId（见下节），重启一次 dsh web
```

**卸载**：`dsh plugin --profile web remove dsh-feishu-board`，并从 `dsh.profile.bundles` 删名。

## 配置

配置优先级：插件 config（`cordis.patch.yml`）→ 环境变量 → 内置默认值。
仓库里不含任何个人 `chat_id` / `open_id` / 绝对路径，必须自己填。

| 键 | 环境变量 | 必填 | 含义 |
|---|---|---|---|
| `chatId` | `DSH_FEISHU_CHAT_ID` | 是 | 你和 bot 的私聊 `oc_…` |
| `userOpenId` | `DSH_FEISHU_USER_OPEN_ID` | 是 | 你本人 `ou_…`（只把这条 id 的消息当答复） |
| `boardDir` | `DSH_FEISHU_BOARD_DIR` | 否 | 公告板目录，默认 `~/.dsh-feishu-board` |
| `larkCli` | `DSH_FEISHU_LARK_CLI` | 否 | lark-cli 路径，默认取 PATH 里的 `lark-cli` |
| `pollIntervalMs` | `DSH_FEISHU_POLL_MS` | 否 | 轮询间隔，默认 10000 |
| `enabled` | `DSH_FEISHU_ENABLED` | 否 | 设 `0` 可临时停用 |

`chatId` / `userOpenId` 缺失时插件不会启动，只在 `board/plugin.json` 里留一条
`enabled:false`，不会静默吞掉问题。

### 怎么拿到 chat_id 和 open_id

```sh
# 你给 bot 发一条消息后，列出 bot 收到的私聊
lark-cli im +chats-list --as bot --page-size 20
# 拿 chatId 后再取你自己在这条会话里的 open_id
lark-cli im +chat-members --chat-id oc_xxx --as bot
```

也可以从 `lark-cli im +messages-send --as bot --user-id ou_xxx --text hi` 的返回里确认。

## 发送出口包装（可选，但推荐）

会话发通知时经常把输出过滤掉（`| grep message_id`），插件靠"工具输出里有没有
`message_id`"来登记寄件人就会漏。`lark-cli-shim.js` 在真正的发送出口上拿一次
`message_id`，连同 `$DSH_SESSION_ID` 追加到 `board/outbound-events.jsonl`，插件每轮并进
`outbound-index.json`——谁发的在发送那一刻就定死了，不用猜。

它同时负责**重复发送抑制**（见下节）。

```sh
# 安装（会先把真实 CLI 另存为 lark-cli.real）
LARK_BIN_DIR=~/bin/bin ./install-lark-shim.sh
# 回滚
mv ~/bin/bin/lark-cli.real ~/bin/bin/lark-cli
```

- 非发送命令原样透传；发送失败不登记；`--dry-run` 不登记。
- `lark-cli update` 会覆盖真实文件，更新后重跑 `install-lark-shim.sh` 一次。
- 公告板位置：`DSH_FEISHU_BOARD_DIR` → `~/.dsh-feishu-board.json`（插件启动时写的指针）。

## 重复发送抑制（v0.2.0）

会话侧常见行为：发成功了，但确认命令把输出过滤掉了，模型以为没发成功，于是原样再发一次
——飞书里就出现同文重复。

包装在发送前比对「同一会话 + 同一目标 + 同一正文」在一个时间窗内是否刚发过：

- 是：不再真的发，把上次的 stdout 原样打回去（调用方看到 `message_id` 就收手），
  stderr 留一行提示；
- 否：正常发送并记状态。

| 环境变量 | 含义 |
|---|---|
| `DSH_FEISHU_DEDUPE_WINDOW_MS` | 时间窗，默认 `180000`（3 分钟）；设 `0` 关闭 |
| `DSH_FEISHU_ALLOW_DUPLICATE` | 设 `1` 强制发送（确实需要连发同文时） |

不同目标、不同正文、不同会话都不受影响。状态文件是 `board/send-dedupe.json`。

## 公告板文件

| 路径 | 说明 |
|---|---|
| `board/questions.jsonl` | 问题台账：`id / session_title / questions / status / feishu_message_id / answer` |
| `board/answers.jsonl` | 回复原始记录：`ts / question_id / raw_text / anchor / delivered / route_by / deliver_error` |
| `board/cursor.json` | 轮询游标（`message_position`），只认新消息 |
| `board/plugin.json` | 心跳：`pid / started_at / last_cycle_at / last_error` |
| `board/outbound-index.json` | 信封索引：`message_id → 发信会话` |
| `board/outbound-events.jsonl` | 包装写的发送登记（每轮消费后清空） |

状态流转：`pending → sent → answered`（飞书答的）/ `answered-web`（Web 先答的）/
`orphaned`（宿主重启时仍有待答，原会话多半已中断）。

## 回复怎么匹配回会话

1. **引用回复**：用 `+messages-mget` 取 `reply_to` 精确锚定该条通知 → 投回发信会话。
2. **没引用**：只认 30 分钟内最近一封登记过的通知；超时就回执提示你引用回复。
3. 匹配不到、或投递失败，插件会在飞书里回你一条说明，原文同时存档到 `answers.jsonl`，
   不会静默。

## 已知边界

- **延迟**：轮询 10 秒一次，不是实时；符合"晚点回也行"的定位。
- **`dsh web` 重启**：内存里等待的问题会丢（工具调用本身也随宿主结束），板子上标成
  `orphaned`；这时你在飞书回复，会被告知无待答问题。
- **跨机器**：只认这台机器发出的通知；别的机器发的通知回复不回来（没有共用索引）。
- **timed 模式**：本插件走竞争式回答，适配阻塞式 `ask_user_question`；改 `timed` 需另走
  迟到回填路径（尚未实现）。
- **权限**：只用 bot 身份，收发都在你这一个私聊里，不碰其他会话。

## 开发/自测

```sh
node --check lib/index.js && node --check lark-cli-shim.js
```

包装的幂等逻辑可以脱离飞书测：把 `LARK_CLI_REAL` 指向一个打印
`{"ok":true,"data":{"message_id":"om_test_1"}}` 的假 CLI，连续发两次同文，只应真实执行一次。

## License

MIT
