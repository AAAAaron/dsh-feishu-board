/**
 * dsh-feishu-board —— 飞书公告板（DSH 宿主插件）
 *
 * 做什么：
 *   1. 监听全局 `user-questions/request`（ask_user_question 的瀑布事件）；
 *   2. 把问题写进公告板 questions.jsonl，并由本插件自己推到飞书私聊；
 *   3. 轮询飞书私聊历史，读到你回复的原文后，作为答案返回给瀑布 →
 *      原会话继续跑（与 Web GUI 竞争，谁先答谁生效）。
 *
 * 为什么是插件而不是脚本：宿主插件随 `dsh web` 常驻，会话开关、连接断开都不影响；
 * 只有 `dsh web` 重启才会重新组装（这是 DSH 的机制）。
 *
 * 设计要点（照 dsh-im 的适配器写法）：
 *   - 注册为 `{ global: true, prepend: true }`，先于 Web 的转发器拿到请求；
 *   - 调 `next()` 让 Web GUI 的答题器照常工作，两边竞争，先答先算；
 *   - 给这条问题一条独立生命周期（私有 AbortController），避免整轮 turn 的
 *     abort 连坐；
 *   - 飞书 IO 用 bot 身份的 lark-cli：`+messages-send` / `+chat-messages-list`，
 *     不需要事件总线、不需要公网回调。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const run = promisify(execFile);

// 默认值全部从环境变量取，仓库里不含任何个人 chat_id / open_id / 本机路径。
// 必填：DSH_FEISHU_CHAT_ID（oc_…，你与 bot 的私聊）、DSH_FEISHU_USER_OPEN_ID（ou_…，你本人）。
// 选填：DSH_FEISHU_BOARD_DIR、DSH_FEISHU_LARK_CLI、DSH_FEISHU_POLL_MS。
const DEFAULTS = {
  boardDir: process.env.DSH_FEISHU_BOARD_DIR || path.join(os.homedir(), '.dsh-feishu-board'),
  chatId: process.env.DSH_FEISHU_CHAT_ID || '',
  userOpenId: process.env.DSH_FEISHU_USER_OPEN_ID || '',
  larkCli: process.env.DSH_FEISHU_LARK_CLI || 'lark-cli',
  pollIntervalMs: Number(process.env.DSH_FEISHU_POLL_MS) || 10000,
  enabled: process.env.DSH_FEISHU_ENABLED !== '0',
};

const now = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });

/** 会话标题兜底：工作目录名 + 会话 id 后 8 位，避免只显示 "session-"。 */
function fallbackTitle(session, sessionId) {
  const cwd = session?.header?.cwd;
  const base = typeof cwd === 'string' ? cwd.split('/').filter(Boolean).pop() : '';
  const short = String(sessionId).replace(/^session-/, '').slice(0, 8);
  return base ? `${base} · ${short}` : short;
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) };
  const QF = path.join(cfg.boardDir, 'questions.jsonl');
  const AF = path.join(cfg.boardDir, 'answers.jsonl');
  const CF = path.join(cfg.boardDir, 'cursor.json');
  const PF = path.join(cfg.boardDir, 'plugin.json');
  const IF = path.join(cfg.boardDir, 'outbound-index.json');
  const EF = path.join(cfg.boardDir, 'outbound-events.jsonl');

  fs.mkdirSync(cfg.boardDir, { recursive: true });

  // 宿主服务读取：bundle 里没声明 inject 时，直接访问 ctx.xxx 会抛
  // `cannot get property "xxx" without inject`（cordis 的依赖约束）。
  // ctx.get() 是 cordis 提供的"不要求 inject"的读取入口；读不到再落回属性访问。
  function service(name) {
    try {
      if (typeof ctx.get === 'function') {
        const v = ctx.get(name);
        if (v !== undefined) return v;
      }
    } catch { /* 落回属性访问 */ }
    try { return ctx[name]; } catch { return undefined; }
  }

  // 单实例保护：宿主热加载可能重复 apply 同一个包（补丁行改一次就多挂一个），
  // 多挂的实例会重复推送、重复轮询，必须在进程内挡住。
  const MOUNT_KEY = Symbol.for('dsh-feishu-board.mounted');
  if (globalThis[MOUNT_KEY] === true) {
    console.warn('[feishu-board] already mounted in this process; skip duplicate apply');
    return;
  }
  globalThis[MOUNT_KEY] = true;

  const status = (patch) => fs.writeFileSync(PF, JSON.stringify({
    pid: process.pid,
    started_at: statusStart,
    last_cycle_at: null,
    ...patch,
  }, null, 2));
  const statusStart = now();

  if (!cfg.enabled || !cfg.chatId || !cfg.userOpenId) {
    status({ enabled: false, reason: 'missing chatId/userOpenId or disabled' });
    console.log('[feishu-board] disabled (missing config)');
    return;
  }

  const readJsonl = (p) => (fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
    : []);
  const writeJsonl = (p, rows) => fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const appendJsonl = (p, row) => fs.appendFileSync(p, JSON.stringify(row) + '\n');
  const readCursor = () => { try { return JSON.parse(fs.readFileSync(CF, 'utf8')).position ?? null; } catch { return null; } };
  const writeCursor = (pos) => fs.writeFileSync(CF, JSON.stringify({ position: String(pos), updated_at: now() }, null, 2));

  // ---- 信封索引：飞书 message_id -> 发信会话 ----
  // 任何会话用 lark-cli 发到本聊天的消息，其工具结果都带 message_id；监听全局 session/event
  // 就能自动建立"这封信是谁寄的"——不要求各对话改习惯，也不需要在消息里贴标签。
  const outbound = new Map(Object.entries((() => {
    try { return JSON.parse(fs.readFileSync(IF, 'utf8'))?.entries ?? {}; } catch { return {}; }
  })()));
  let outboundDirty = false;
  const saveOutbound = () => {
    if (!outboundDirty) return;
    try {
      const entries = Object.fromEntries([...outbound].slice(-2000));
      fs.writeFileSync(IF, JSON.stringify({ updated_at: now(), entries }, null, 2));
      outboundDirty = false;
    } catch { /* 落盘失败不影响投递 */ }
  };
  const indexOutbound = (messageId, sessionId) => {
    if (typeof messageId !== 'string' || typeof sessionId !== 'string') return;
    if (outbound.has(messageId)) return;
    outbound.set(messageId, { sessionId, at: now() });
    outboundDirty = true;
    saveOutbound();
  };
  // 兜底路由只认"还新鲜"的信：隔了几个小时的通知早该按引用走，不能拿来猜。
  const LETTER_TTL_MS = 30 * 60 * 1000;
  const freshLetter = (messageId) => {
    const e = outbound.get(messageId);
    if (!e?.at || e.at === 'backfill') return false;
    const t = Date.parse(String(e.at).replace(' ', 'T') + '+08:00');
    return Number.isFinite(t) && Date.now() - t <= LETTER_TTL_MS;
  };
  function indexSessionEvent(sessionId, event) {
    if (typeof sessionId !== 'string' || !event) return;
    if (event.type !== 'tool/result') return;
    const parts = event.data?.message?.content;
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (part?.type !== 'text' || typeof part.text !== 'string') continue;
      const text = part.text;
      if (!text.includes('om_') || !text.includes(cfg.chatId)) continue;
      const rx = /"(?:message_id|id)"\s*:\s*"(om_[A-Za-z0-9]+)"/g;
      let hit;
      while ((hit = rx.exec(text)) !== null) indexOutbound(hit[1], sessionId);
    }
  }

  // ---- 引用锚定：`+chat-messages-list` 不返回引用信息，必须用 `+messages-mget` 取 `reply_to` ----
  async function replyAnchorOf(messageId) {
    try {
      const res = await lark(['im', '+messages-mget', '--message-ids', messageId, '--as', 'bot']);
      const m = (res?.data?.messages ?? [])[0];
      return m?.reply_to ?? m?.parent_id ?? m?.root_id ?? null;
    } catch {
      return null;
    }
  }

  // ---- 发送意图：会话跑 lark-cli 发消息时，先把"谁在什么时候发了一封"记下来 ----
  // 只靠工具输出里的 message_id 不可靠：很多会话会 `| grep message_id` 过滤输出，
  // 结果文本里既没有 chat_id 也没有完整 JSON，登记就漏了。这里按"发了"这件事本身
  // 登记，轮询到新的通知消息时再用时间窗配对（要求窗口内只有唯一候选，宁缺毋滥）。
  const letters = [];
  function captureSendIntent(sessionId, event) {
    if (typeof sessionId !== 'string' || event?.type !== 'tool/call') return;
    if (event.data?.name !== 'bash') return;
    let args;
    try { args = JSON.parse(event.data?.arguments ?? '{}'); } catch { return; }
    const cmd = args?.command;
    if (typeof cmd !== 'string' || !cmd.includes('+messages-send')) return;
    const kind = /--file\s/.test(cmd) ? 'file' : /--(?:text|markdown)\s/.test(cmd) ? 'text' : 'unknown';
    letters.push({ sessionId, at: Date.now(), kind, claimed: false });
    if (letters.length > 200) letters.splice(0, letters.length - 200);
  }
  const FEISHU_TIME = (s) => {
    const t = Date.parse(String(s ?? '').replace(' ', 'T') + '+08:00');
    return Number.isFinite(t) ? t : NaN;
  };
  function attributeLetter(m) {
    if (outbound.has(m.message_id)) return;
    const t = FEISHU_TIME(m.create_time);
    if (!Number.isFinite(t)) return;
    const cands = letters.filter((l) => !l.claimed && Math.abs(t - l.at) <= 3 * 60 * 1000);
    if (cands.length !== 1) return;          // 有歧义就不猜
    cands[0].claimed = true;
    indexOutbound(m.message_id, cands[0].sessionId);
  }

  // 发送出口（lark-cli 包装）每发一封就写一行登记：谁发的、message_id 是什么。
  // 这里每轮把登记并进索引——不再依赖工具输出文本，也就不会因为 `| grep` 而漏。
  function drainOutboundEvents() {
    const staged = `${EF}.${process.pid}.${Date.now()}.drain`;
    try { fs.renameSync(EF, staged); } catch { return; }   // 没有新登记
    let raw = '';
    try { raw = fs.readFileSync(staged, 'utf8'); } catch { /* 读失败就丢弃本批 */ }
    try { fs.unlinkSync(staged); } catch { /* 留着也无碍 */ }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (typeof e?.message_id === 'string' && typeof e?.session_id === 'string') {
        indexOutbound(e.message_id, e.session_id);
      }
    }
  }

  // 投递：把用户回复作为一条新的用户消息送回目标会话（冷会话会被自动 resume）
  async function deliverToSession(sessionId, text) {
    const controller = service('sessionController');
    if (typeof controller?.prompt !== 'function') {
      throw new Error('sessionController.prompt unavailable');
    }
    await controller.prompt({
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, new AbortController().signal);
  }

  async function lark(args) {
    const cliDir = path.dirname(path.resolve(cfg.larkCli));
    const { stdout } = await run(cfg.larkCli, args, {
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        PATH: `${cliDir}${path.delimiter}${process.env.PATH ?? ''}`,
        // 让 lark-cli 的发送出口包装即使被别的进程调起也能找到同一个公告板
        DSH_FEISHU_BOARD_DIR: cfg.boardDir,
      },
    });
    return JSON.parse(stdout);
  }
  const sendText = (text) => lark(['im', '+messages-send', '--as', 'bot', '--user-id', cfg.userOpenId, '--text', text]);

  // ---------- 问题 → 飞书 ----------

  const pending = new Map();   // boardId -> { resolve, record }
  let counter = Date.now() % 100000;

  function formatQuestion(r) {
    const lines = [`【公告板 ${r.id}】来自《${r.session_title}》`];
    r.questions.forEach((q, i) => {
      lines.push(r.questions.length > 1 ? `${i + 1}. ${q.question}` : q.question);
      if (q.detail) lines.push(q.detail);
      if (q.options?.length) lines.push('选项：' + q.options.map((o, j) => `${j + 1} ${o.label}`).join(' / '));
      if (q.multiSelect) lines.push('（可多选，回复用逗号分隔）');
    });
    if (r.questions.length > 1) {
      lines.push(`（共 ${r.questions.length} 题：按行回答，第 1 行答第 1 题，依此类推）`);
    }
    lines.push('——直接回复本条消息即可，晚点回也行。');
    return lines.join('\n');
  }

  async function pushPending() {
    const rows = readJsonl(QF);
    let changed = false;
    for (const r of rows) {
      if (r.status !== 'pending' || r.feishu_message_id) continue;
      try {
        if (!r.session_title || r.session_title === 'session-') {
          try {
            const snap = await service('sessionQuery')?.readTitle?.(r.session_id);
            const t = snap?.title;
            if (typeof t === 'string' && t.trim()) {
              r.session_title = t.trim();
              changed = true;
            }
          } catch { /* 标题读取失败就用兜底，不影响推送 */ }
        }
        const res = await sendText(formatQuestion(r));
        const data = res?.data ?? res;
        r.feishu_message_id = data?.message_id ?? null;
        r.feishu_chat_id = data?.chat_id ?? cfg.chatId;
        r.status = 'sent';
        r.sent_at = now();
        if (r.feishu_message_id) indexOutbound(r.feishu_message_id, r.session_id);
        changed = true;
        console.log(`[feishu-board] pushed ${r.id} -> ${r.feishu_message_id}`);
      } catch (e) {
        console.warn(`[feishu-board] push ${r.id} failed: ${e?.message ?? e}`);
      }
    }
    if (changed) writeJsonl(QF, rows);
  }

  // ---------- 飞书 → 答案 ----------

  function matchOptions(options, text) {
    if (!options?.length) return [];
    const norm = (s) => String(s).trim().toLowerCase();
    const picked = [];
    for (const part of String(text).split(/[,，、;；\s]+/).filter(Boolean)) {
      const p = norm(part);
      if (/^\d+$/.test(p)) {
        const o = options[Number(p) - 1];
        if (o && !picked.includes(o.label)) picked.push(o.label);
        continue;
      }
      if (/^[a-z]$/.test(p)) {
        const o = options[p.charCodeAt(0) - 97];
        if (o && !picked.includes(o.label)) picked.push(o.label);
        continue;
      }
      const o = options.find((x) => norm(x.label) === p)
        || options.find((x) => p.length >= 2 && norm(x.label).includes(p));
      if (o && !picked.includes(o.label)) picked.push(o.label);
    }
    return picked;
  }

  function buildAnswer(questions, raw) {
    const stripped = String(raw).replace(/^\s*(?:选|选择|答案是|答案[:：]?)\s*/u, '').trim();
    const chunks = questions.length > 1
      ? stripped.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      : [stripped];
    return {
      answers: questions.map((q, i) => {
        const text = questions.length > 1 ? (chunks[i] ?? stripped) : stripped;
        const selected = matchOptions(q.options ?? [], text);
        const item = { id: q.id, selected };
        if (!selected.length) item.custom = text;
        return item;
      }),
    };
  }

  async function pullReplies() {
    const res = await lark(['im', '+chat-messages-list', '--chat-id', cfg.chatId, '--order', 'desc', '--limit', '50', '--as', 'bot']);
    const msgs = (res?.data?.messages ?? []).slice().reverse();   // 升序
    if (!msgs.length) return;
    const maxPos = msgs.reduce((m, x) => Math.max(m, Number(x.message_position || 0)), 0);
    const cursor = readCursor();
    if (cursor === null) {
      writeCursor(maxPos);
      console.log(`[feishu-board] cursor init = ${maxPos}（忽略历史消息）`);
      return;
    }
    for (const m of msgs) {
      if (Number(m.message_position || 0) <= Number(cursor)) continue;
      writeCursor(m.message_position);
      if (m.sender?.sender_type === 'app') { attributeLetter(m); continue; }
      if (m.sender?.sender_type !== 'user') continue;

      const raw = String(m.content ?? '').trim();
      if (!raw) continue;
      // 引用回复：优先用消息自身字段，再补一次 mget（list 命令不带引用信息）
      const anchor = m.reply_to || m.parent_id || m.root_id || await replyAnchorOf(m.message_id);
      const rows = readJsonl(QF);
      let target = anchor ? rows.find((r) => r.feishu_message_id === anchor) : null;
      if (!target) target = rows.find((r) => r.status === 'sent');

      // 1) 有正在等待的 ask_user_question：优先回填工具答案（阻塞式问答）
      let delivered = false;
      let deliverError = null;
      if (target && pending.get(target.id)) {
        pending.get(target.id).resolve(buildAnswer(target.questions, raw));
        delivered = true;
        target.answer = raw;
        target.answered_at = now();
        target.answer_message_id = m.message_id;
        target.answer_source = 'feishu';
        target.status = 'answered';
        writeJsonl(QF, rows);
      }

      // 2) 否则按"信封"投递：引用哪条就投回哪条；没引用就投给最近一封已登记的信
      let sessionId = null;
      let routeBy = null;
      if (!delivered) {
        if (anchor && outbound.has(anchor)) {
          sessionId = outbound.get(anchor).sessionId;
          routeBy = 'anchor';
        } else {
          for (let i = msgs.indexOf(m) - 1; i >= 0; i -= 1) {
            const prev = msgs[i];
            if (prev.sender?.sender_type !== 'app') continue;
            if (freshLetter(prev.message_id)) {
              sessionId = outbound.get(prev.message_id).sessionId;
              routeBy = 'latest-letter';
              break;
            }
          }
        }
        if (sessionId) {
          try {
            await deliverToSession(sessionId, raw);
            delivered = true;
          } catch (e) {
            deliverError = `${e?.code ?? 'ERROR'}: ${e?.message ?? e}`;
            console.warn(`[feishu-board] deliver to ${sessionId} failed: ${deliverError}`);
          }
        }
      }

      appendJsonl(AF, {
        ts: now(), question_id: target?.id ?? null, raw_text: raw, anchor,
        feishu_message_id: m.message_id, position: String(m.message_position),
        delivered, delivered_to_session: sessionId, route_by: routeBy,
        deliver_error: deliverError,
      });
      console.log(`[feishu-board] reply ${delivered ? 'delivered' : 'stored'}${target ? ` q=${target.id}` : ''}${sessionId ? ` session=${sessionId} (${routeBy})` : ''}: ${raw.slice(0, 80)}`);

      if (!delivered) {
        try {
          await sendText(sessionId
            ? `（这条回复已匹配到对话 ${sessionId}，但投递失败：${deliverError ?? '未知原因'}。原文已存档。）`
            : '（这条回复没有匹配到任何对话：它回复的那条通知可能不是从这台机器发出的。原文已存档。）');
        } catch { /* 通知失败不影响主流程 */ }
      }
    }
  }

  let cycling = false;
  async function cycle() {
    if (cycling) return;          // 上一轮还没跑完：跳过本轮，避免重复读同一段消息/重复 ack
    cycling = true;
    try {
      drainOutboundEvents();
      await pushPending();
      await pullReplies();
      status({ last_cycle_at: now() });
    } catch (e) {
      console.warn(`[feishu-board] cycle failed: ${e?.message ?? e}`);
      status({ last_cycle_at: now(), last_error: String(e?.message ?? e) });
    } finally {
      cycling = false;
    }
  }

  // ---------- ask_user_question 适配器 ----------

  function requestQuestion(request, next) {
    const agent = request?.agent;
    const session = agent?.session;
    const sessionId = session?.id ?? agent?.id;
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    if (typeof sessionId !== 'string' || !questions.length) return next();

    const id = `Q${++counter}`;
    const title = session?.title ?? session?.meta?.title ?? fallbackTitle(session, sessionId);
    const record = {
      id,
      created: now(),
      channel: 'lark-cli-dm',
      session_id: sessionId,
      session_title: title,
      call_id: request?.wait?.callId ? String(request.wait.callId) : null,
      questions,
      status: 'pending',
      feishu_message_id: null,
      answer: null,
      answered_at: null,
    };
    appendJsonl(QF, record);

    let resolve = null;
    const answerPromise = new Promise((res) => { resolve = res; });
    pending.set(id, { resolve, record });
    console.log(`[feishu-board] question ${id} from 《${title}》: ${questions.map((q) => q.question).join(' | ').slice(0, 120)}`);

    const turnSignal = request?.signal;
    if (turnSignal?.aborted) {
      pending.delete(id);
      return next();
    }

    // 给这条问题一条独立生命周期：turn 被 abort 时同步进来，
    // 但淘汰 Web 卡片不会连坐到同一轮里其他等待中的工具调用。
    const question = new AbortController();
    const forwardTurnAbort = () => question.abort(turnSignal?.reason);
    turnSignal?.addEventListener('abort', forwardTurnAbort, { once: true });
    request.signal = question.signal;

    let answeredByBoard = false;
    const native = Promise.resolve()
      .then(() => next())
      .catch((error) => {
        if (error?.code !== 'NO_PROVIDER' && error?.code !== 'ASK_ABORTED') {
          console.warn(`[feishu-board] host answerer failed, still waiting on Feishu: ${error?.message ?? error}`);
        }
        return new Promise(() => {});   // 没有 Web 客户端也照样等飞书
      });

    return Promise.race([
      native,
      answerPromise.then((value) => { answeredByBoard = true; return value; }),
    ]).finally(() => {
      pending.delete(id);
      turnSignal?.removeEventListener('abort', forwardTurnAbort);
      if (answeredByBoard) {
        question.abort(Object.assign(new Error('answered on Feishu board'), { code: 'ASK_ABORTED' }));
      } else if (!turnSignal?.aborted) {
        try {
          const rows = readJsonl(QF);
          const r = rows.find((x) => x.id === id);
          if (r && (r.status === 'pending' || r.status === 'sent')) {
            r.status = 'answered-web';
            r.answered_at = now();
            r.answer_source = 'web';
            writeJsonl(QF, rows);
          }
        } catch { /* 标记失败不影响主流程 */ }
      }
    });
  }

  // ---------- 启动 ----------

  // 上次宿主运行遗留的待答问题：标记失联，避免你回了一条已失效的问题却没人告诉你。
  try {
    const rows = readJsonl(QF);
    let changed = false;
    for (const r of rows) {
      if (r.status === 'sent' || r.status === 'pending') {
        r.status = 'orphaned';
        r.note = '宿主重启前的待答问题，原会话可能已中断';
        changed = true;
      }
    }
    if (changed) writeJsonl(QF, rows);
  } catch { /* 首次运行没有文件 */ }

  ctx.on('user-questions/request', requestQuestion, { global: true, prepend: true });
  ctx.on('session/event', (session, event) => {
    indexSessionEvent(session?.id, event);
    captureSendIntent(session?.id, event);
  }, { global: true });

  const timer = setInterval(cycle, Math.max(3000, Number(cfg.pollIntervalMs) || 10000));
  if (typeof timer.unref === 'function') timer.unref();
  const stop = () => {
    clearInterval(timer);
    if (globalThis[MOUNT_KEY] === true) delete globalThis[MOUNT_KEY];
  };

  ctx.on('dispose', stop);

  // 公告板指针：会话里调起的 lark-cli 包装靠它找到同一份 board（环境变量优先）。
  try {
    fs.writeFileSync(path.join(os.homedir(), '.dsh-feishu-board.json'), JSON.stringify({
      boardDir: cfg.boardDir, updated_at: now(),
    }, null, 2));
  } catch { /* 指针写不了不影响主流程 */ }

  status({ last_cycle_at: null, board: cfg.boardDir, chat_id: cfg.chatId });
  cycle();
  console.log(`[feishu-board] started; board=${cfg.boardDir}; chat=${cfg.chatId}; every ${cfg.pollIntervalMs}ms`);
}
