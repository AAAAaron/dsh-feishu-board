#!/bin/bash
# 安装/重装 lark-cli 发送出口包装（登记 message_id → $DSH_SESSION_ID，并按会话做重复发送抑制）。
#
# 用法：
#   LARK_BIN_DIR=~/bin/bin BOARD_DIR=~/.dsh-feishu-board ./install-lark-shim.sh
#
# 说明：lark-cli 自更新会覆盖真实文件，更新后重跑本脚本一次即可；回滚见 README。
set -euo pipefail

BIN="${LARK_BIN_DIR:-$(dirname "$(command -v lark-cli 2>/dev/null || echo /usr/local/bin/lark-cli)")}"
SRC="$(cd "$(dirname "$0")" && pwd)/lark-cli-shim.js"

[ -f "$SRC" ] || { echo "找不到 lark-cli-shim.js：$SRC"; exit 1; }
if [ ! -e "$BIN/lark-cli.real" ]; then
  if [ -e "$BIN/lark-cli" ]; then
    cp -P "$BIN/lark-cli" "$BIN/lark-cli.real"; echo "已把真实 CLI 另存为：$BIN/lark-cli.real"
  else
    echo "找不到 lark-cli：$BIN/lark-cli（用 LARK_BIN_DIR 指定所在目录）"; exit 1
  fi
fi

cp "$SRC" "$BIN/lark-cli"
chmod +x "$BIN/lark-cli"
echo "已安装：$BIN/lark-cli（真实 CLI: $BIN/lark-cli.real）"
"$BIN/lark-cli" --version || true
echo "提示：公告板位置由 DSH_FEISHU_BOARD_DIR 或 ~/.dsh-feishu-board.json 决定；插件启动时会自动写指针。"
