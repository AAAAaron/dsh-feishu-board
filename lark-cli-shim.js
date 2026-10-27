#!/usr/bin/env node
/**
 * lark-cli 发送出口包装（DocFerry / dsh-feishu-board 用）
 *
 * 为什么存在：会话发通知时经常把输出过滤掉（`| grep message_id`），甚至不打印结果，
 * 插件靠"工具输出里有没有 message_id"来登记寄件人就会漏。这里在真正的发送出口上
 * 拿一次 message_id，连同 $DSH_SESSION_ID 追加到 board/outbound-events.jsonl，
 * 插件每轮把它并进索引——谁发的在发送那一刻就定死了，不用猜。
 *
 * 幂等（v2，2026-10-27）：
 *   会话侧经常"发成功但没看到结果 → 原样再发一次"，于是飞书里出现同文重复。
 *   包装在发送前比对"同一会话 + 同一目标 + 同一正文"在一个时间窗内是否刚发过；
 *   是则不再真的发，直接把上次的 stdout 原样打回去（调用方看到 message_id 就收手），
 *   并在 stderr 留一行提示。窗口默认 180 秒，可用 DSH_FEISHU_DEDUPE_WINDOW_MS 调整，
 *   设 0 关闭；确实需要连发同文时置 DSH_FEISHU_ALLOW_DUPLICATE=1 绕过。
 *
 * 非发送命令：原样透传，行为与原来完全一致（只多一层 node 启动）。
 * 发送命令：透传 stdout/stderr 与退出码，同时登记 + 幂等。
 *
 * 回滚：把 bin/lark-cli 换回 bin/lark-cli.real 即可（本包装不修改真实 CLI）。
 * 注意：`lark-cli update` 会替换真实文件，更新后需重新安装本包装。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const REAL = process.env.LARK_CLI_REAL || path.join(__dirname, 'lark-cli.real');
/** 公告板位置：环境变量 → 插件写的指针文件（~/.dsh-feishu-board.json）→ 空（只透传）。 */
function resolveBoard() {
  if (process.env.DSH_FEISHU_BOARD_DIR) return process.env.DSH_FEISHU_BOARD_DIR;
  try {
    const p = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.dsh-feishu-board.json'), 'utf8'));
    if (p && typeof p.boardDir === 'string' && p.boardDir) return p.boardDir;
  } catch { /* 没装插件或还没启动过 */ }
  return '';
}
const BOARD = resolveBoard();
const SESSION = process.env.DSH_SESSION_ID || '';
const WINDOW = Math.max(0, Number(process.env.DSH_FEISHU_DEDUPE_WINDOW_MS ?? 180000) || 0);
const ALLOW_DUP = process.env.DSH_FEISHU_ALLOW_DUPLICATE === '1';
const STATE = BOARD ? path.join(BOARD, 'send-dedupe.json') : '';
const EVENTS = BOARD ? path.join(BOARD, 'outbound-events.jsonl') : '';

const argv = process.argv.slice(2);
const isSend = argv.some((a) => /^\+.*(?:send|reply)/i.test(a));

function finish(code, signal) {
  if (signal) { process.kill(process.pid, signal); return; }
  process.exit(typeof code === 'number' ? code : 0);
}

/** 取 flag 后面的值（支持 --flag value 与 --flag=value）。 */
function flagValue(name) {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === name) return argv[i + 1] ?? '';
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return '';
}

/** 幂等键：会话 + 目标 + 正文。换个人/换个聊天/换段文字都不算重复。 */
function dedupeKey() {
  const target = [
    flagValue('--chat-id'), flagValue('--user-id'), flagValue('--open-id'),
    flagValue('--emails'), flagValue('--message-id'), flagValue('--message-ids'),
  ].join('|');
  const body = [
    flagValue('--text'), flagValue('--markdown'), flagValue('--content'), flagValue('--file'),
  ].join('|');
  if (!body.trim()) return '';
  return crypto.createHash('sha256').update(`${SESSION}\u0000${target}\u0000${body}`).digest('hex');
}

function readState() {
  if (!STATE) return {};
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch { return {}; }
}
function writeState(state) {
  if (!STATE) return;
  try {
    fs.mkdirSync(BOARD, { recursive: true });
    const cutoff = Date.now() - Math.max(WINDOW * 4, 3600000);
    for (const [k, v] of Object.entries(state)) {
      if (!v || typeof v.ts !== 'number' || v.ts < cutoff) delete state[k];
    }
    fs.writeFileSync(STATE, JSON.stringify(state));
  } catch { /* 状态落盘失败不影响发送 */ }
}

function register(messageId) {
  if (!messageId || !SESSION || !EVENTS) return;
  try {
    fs.mkdirSync(BOARD, { recursive: true });
    fs.appendFileSync(EVENTS, `${JSON.stringify({
      at: new Date().toISOString(), message_id: messageId, session_id: SESSION,
    })}\n`);
  } catch { /* 登记失败不影响发送本身 */ }
}

if (!isSend) {
  const p = spawn(process.execPath, [REAL, ...argv], { stdio: 'inherit', env: process.env });
  p.on('error', () => process.exit(1));
  p.on('exit', (code, signal) => finish(code, signal));
} else {
  // 明确的重复：不再真的发，把上次的输出原样还回去，让调用方看到"已发成功"。
  const key = (WINDOW > 0 && !ALLOW_DUP && SESSION && BOARD) ? dedupeKey() : '';
  if (key) {
    const prev = readState()[key];
    if (prev && typeof prev.ts === 'number' && Date.now() - prev.ts <= WINDOW && prev.stdout) {
      process.stdout.write(prev.stdout);
      process.stderr.write(`[lark-cli-shim] duplicate send suppressed (${Math.round((Date.now() - prev.ts) / 1000)}s ago, message_id=${prev.message_id ?? 'unknown'}); retry with DSH_FEISHU_ALLOW_DUPLICATE=1 to force\n`);
      process.exit(0);
    }
  }

  const p = spawn(process.execPath, [REAL, ...argv], { stdio: ['inherit', 'pipe', 'inherit'], env: process.env });
  let out = '';
  p.stdout.on('data', (d) => { out += d.toString('utf8'); process.stdout.write(d); });
  p.on('error', () => process.exit(1));
  p.on('exit', (code, signal) => {
    try {
      const hit = out.match(/"message_id"\s*:\s*"(om_[A-Za-z0-9_]+)"/);
      if (hit) {
        register(hit[1]);
        if (key) {
          const state = readState();
          state[key] = { ts: Date.now(), message_id: hit[1], stdout: out.slice(0, 4096) };
          writeState(state);
        }
      }
    } catch { /* 登记失败不影响发送 */ }
    finish(code, signal);
  });
}
