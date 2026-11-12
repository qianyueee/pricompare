'use strict';
// PO 跟单列表页：读 /api/orders，按供应商交期的紧急程度上色、筛选、排序；点一行展开零件明细。
// 数据有两种来源：跟单人员上传的跟单总表（source: "tracker"，状态全看表里人填的），或从邮件整理的（旧）。

const RED_DAYS = 3; // 0–3 天：红
const AMBER_DAYS = 7; // 4–7 天：黄
const DONE = new Set(['已发货', '已完成', '已取消']);
const LEVELS = [
  { key: 'open', label: '未完成' },
  { key: 'overdue', label: '逾期' },
  { key: 'red', label: '3 天内' },
  { key: 'amber', label: '7 天内' },
  { key: 'green', label: '7 天以上' },
  { key: 'nodate', label: '没写交期' },
  { key: 'done', label: '已发货 / 完成' },
  { key: 'all', label: '全部' },
];
const RANK = { overdue: 0, red: 1, amber: 2, green: 3, nodate: 4, done: 5 };
const WEEK = '日一二三四五六';
const PREF_KEY = 'po-tracker-prefs-2';

const $ = (id) => document.getElementById(id);
const state = {
  orders: [],
  meta: {},
  level: 'open',
  supplier: '__all',
  q: '',
  sort: 'urgency',
  open: new Set(),
  loadedAt: 0,
};

// ---------------------------------------------------------------- 小工具

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
}

function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function md(d, withYear) {
  const s = `${d.getMonth() + 1}/${d.getDate()}`;
  return withYear || d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}/${s}` : s;
}

function fmtDay(s) {
  const d = parseDay(s);
  return d ? md(d) : '';
}

function fmtDateTime(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || isNaN(d)) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${md(d)} ${hh}:${mm}`;
}

// 总表里的「预计发货日期」可能是日期，也可能是「随时」「待定」这种字
function dayOrText(s) {
  return parseDay(s) ? fmtDay(s) : s || '';
}

function isTracker(o) {
  return o.source === 'tracker';
}

function money(amount, currency) {
  if (amount === null || amount === undefined || amount === '' || isNaN(+amount)) return '';
  const sym = currency === 'USD' ? '$' : currency === 'RMB' || currency === 'CNY' ? '¥' : '';
  return sym + (+amount).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function num(v) {
  return v === null || v === undefined || v === '' ? '' : (+v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (typeof p.level === 'string') state.level = p.level;
    if (typeof p.supplier === 'string') state.supplier = p.supplier;
    if (typeof p.sort === 'string') state.sort = p.sort;
  } catch (e) {
    /* 隐私模式等读不了就用默认 */
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ level: state.level, supplier: state.supplier, sort: state.sort }));
  } catch (e) {
    /* 忽略 */
  }
}

// ---------------------------------------------------------------- 紧急程度

function classify(o) {
  if (o.closed || DONE.has(o.status)) return { key: 'done', pill: o.status || '完成', days: null };
  const due = parseDay(o.due_date);
  if (!due) return { key: 'nodate', pill: '没写交期', days: null };
  const days = Math.round((due - today()) / 864e5);
  if (days < 0) return { key: 'overdue', pill: `逾期 ${-days} 天`, days };
  if (days === 0) return { key: 'red', pill: '今天到期', days };
  if (days <= RED_DAYS) return { key: 'red', pill: `还剩 ${days} 天`, days };
  if (days <= AMBER_DAYS) return { key: 'amber', pill: `还剩 ${days} 天`, days };
  return { key: 'green', pill: `还剩 ${days} 天`, days };
}

const haystacks = new WeakMap();
function haystack(o) {
  let h = haystacks.get(o);
  if (!h) {
    const parts = [o.po, ...(o.aliases || []), o.supplier, o.customer_po, o.customer, o.end_user, o.status, o.status_note, o.tracking, o.due_text, ...(o.notes || []), ...(o.eta || [])];
    for (const l of o.lines || []) parts.push(l.pn, l.rev, l.desc, l.note, l.customer_po, l.invoice, l.next_step, l.clean_no, l.logistics);
    h = parts.filter(Boolean).join(' ').toLowerCase();
    haystacks.set(o, h);
  }
  return h;
}

function supplierOf(o) {
  return o.supplier || '';
}

// 同一个 PO 号偶尔会给两家供应商用（如 44278），所以展开状态按「PO 号 + 供应商」记
function rowKey(o) {
  return `${o.po}|${supplierOf(o)}`;
}

// ---------------------------------------------------------------- 排序

function byNullable(a, b, dir) {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * dir;
}

function dayNum(s) {
  const d = parseDay(s);
  return d ? d.getTime() : null;
}

function poCmp(a, b) {
  return String(a.po || '').localeCompare(String(b.po || ''), 'en', { numeric: true });
}

const SORTS = {
  urgency: (a, b) =>
    RANK[a._u.key] - RANK[b._u.key] ||
    byNullable(dayNum(a.due_date), dayNum(b.due_date), a._u.key === 'done' ? -1 : 1) ||
    poCmp(a, b),
  due: (a, b) => byNullable(dayNum(a.due_date), dayNum(b.due_date), 1) || poCmp(a, b),
  order: (a, b) => byNullable(dayNum(a.order_date), dayNum(b.order_date), -1) || poCmp(b, a),
  po: (a, b) => poCmp(a, b),
  amount: (a, b) => byNullable(a.amount ?? null, b.amount ?? null, -1) || poCmp(a, b),
};

// ---------------------------------------------------------------- 渲染

function renderChips(counts) {
  $('chips').innerHTML = LEVELS.map((lv) => {
    const n = counts[lv.key] || 0;
    const cls = ['chip', lv.key === 'all' ? '' : `u-${lv.key}`, n ? '' : 'zero'].join(' ');
    const dot = lv.key === 'all' ? '' : '<span class="dot"></span>';
    return `<button type="button" class="${cls}" data-level="${lv.key}" aria-pressed="${state.level === lv.key}">${dot}${esc(lv.label)} <span class="n">${n}</span></button>`;
  }).join('');
}

function renderSuppliers() {
  const counts = new Map();
  for (const o of state.orders) counts.set(supplierOf(o), (counts.get(supplierOf(o)) || 0) + 1);
  const names = [...counts.keys()].sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b, 'zh'));
  if (state.supplier !== '__all' && !counts.has(state.supplier === '__none' ? '' : state.supplier)) state.supplier = '__all';
  $('supplier').innerHTML =
    `<option value="__all">全部供应商</option>` +
    names
      .map((n) => {
        const v = n === '' ? '__none' : n;
        return `<option value="${esc(v)}"${state.supplier === v ? ' selected' : ''}>${esc(n || '供应商未定')}（${counts.get(n)}）</option>`;
      })
      .join('');
  $('supplier').value = state.supplier;
}

// 状态格：总表来的显示人填的备注原文和预计发货；邮件来的显示整理出的状态
function statusCell(o) {
  if (!isTracker(o)) {
    return `<span class="st st-${esc(o.status || '')}">${esc(o.status || '—')}</span>${o.status_note ? `<span class="muted st-note clip">${esc(o.status_note)}</span>` : ''}`;
  }
  if (o.closed) return `<span class="st st-${esc(o.status)}">${esc(o.status || '完成')}</span>`;
  const parts = [];
  const notes = o.notes || [];
  if (notes.length) parts.push(`<span class="note clip" title="${esc(notes.join('\n'))}">${notes.map(esc).join('<br>')}</span>`);
  const eta = (o.eta || []).map(dayOrText).filter(Boolean);
  if (eta.length) parts.push(`<span class="eta">预计发货 ${esc(eta.join('、'))}</span>`);
  const total = (o.lines || []).length;
  if (total > 1 && o.open_lines < total) parts.push(`<span class="muted">${total - o.open_lines}/${total} 行已结束</span>`);
  return parts.length ? parts.join('') : '<span class="none">没写备注</span>';
}

function cells(o) {
  const u = o._u;
  const due = parseDay(o.due_date);
  const dueHtml = due
    ? `<span class="due-date">${esc(md(due))}</span><span class="wd">周${WEEK[due.getDay()]}</span>`
    : o.due_text
      ? `<span class="raw">${esc(o.due_text)}</span>`
      : '';
  const aliases = (o.aliases || []).filter(Boolean);
  const lines = o.lines || [];
  const amt = money(o.amount, o.currency);
  return `
    <td class="c-due">${dueHtml}${due ? '<br>' : ''}<span class="pill">${esc(u.pill)}</span></td>
    <td class="c-po"><span class="po">${esc(o.po)}</span><span class="po-sup">${esc(o.supplier || '供应商未定')}</span>${aliases.length ? `<span class="alias">原 ${esc(aliases.join('、'))}</span>` : ''}</td>
    <td class="c-sup">${o.supplier ? esc(o.supplier) : '<span class="none">未定</span>'}</td>
    <td class="c-status">${statusCell(o)}</td>
    <td class="c-cust"><span>${o.customer_po ? esc(o.customer_po) : '<span class="none">—</span>'}</span>${o.end_user ? `<span class="muted">${esc(o.end_user)}</span>` : ''}</td>
    <td class="c-lines">${lines.length ? `${lines.length} 行<div class="muted">${esc(lines[0].pn || lines[0].desc || '')}${lines.length > 1 ? ' 等' : ''}</div>` : '<span class="none">—</span>'}</td>
    <td class="c-amt">${amt ? `<span class="amt">${esc(amt)}</span>${o.tax ? `<div class="tax">${esc(o.tax)}</div>` : ''}` : '<span class="none">—</span>'}</td>
    <td class="c-ord">${o.order_date ? esc(fmtDay(o.order_date)) : '<span class="none">—</span>'}</td>`;
}

function lineShip(l) {
  if (l.shipped) return `<span class="ship">已发 ${esc(fmtDay(l.shipped))}</span>`;
  return l.eta ? `预计 ${esc(dayOrText(l.eta))}` : '';
}

function trackerDetail(o) {
  const facts = [];
  const add = (k, v) => v && facts.push(`<span>${esc(k)} <b>${esc(v)}</b></span>`);
  add('下单', fmtDay(o.order_date));
  add('各行交期', o.due_text);
  add('客户交期', fmtDay(o.customer_due));
  add('已发货', (o.shipped || []).map(fmtDay).join('、'));
  const fixed = (o.overridden || []).length ? `<span class="tag-fixed" title="${esc(o.overridden.join('、'))}">手工更正过</span>` : '';
  const lines = o.lines || [];
  const rows = lines
    .map((l) => {
      const extra = [
        l.next_step && `下一站 ${l.next_step}`,
        l.logistics && `物流 ${l.logistics}`,
        l.clean_no && `清洗单 ${l.clean_no}`,
        l.invoice && `Invoice ${l.invoice}`,
      ].filter(Boolean);
      const cpo = [l.customer_po, l.customer_line].filter(Boolean).join(' / ');
      return `<tr class="${l.closed ? 'ln-closed' : ''}">
        <td class="pn">${esc(l.pn)}${l.rev ? ` <span class="muted">Rev ${esc(l.rev)}</span>` : ''}</td>
        <td class="desc">${esc(l.desc)}</td>
        <td class="num qty" data-label="数量 ">${esc(num(l.qty))}</td>
        <td class="num up">${esc(num(l.unit_price))}</td>
        <td class="num amt-l">${esc(num(l.amount))}</td>
        <td class="nowrap due-l" data-label="交期 ">${esc(fmtDay(l.wo_due))}</td>
        <td class="cpo">${esc(cpo)}</td>
        <td class="nowrap ship-l">${lineShip(l)}</td>
        <td class="ln-note">${esc(l.note)}${extra.length ? `<div class="muted">${esc(extra.join(' · '))}</div>` : ''}</td>
      </tr>`;
    })
    .join('');
  return `<div class="dl dl-full">
      <div class="facts">${facts.join('')}${fixed}</div>
      <div><h3>零件明细（${lines.length} 行${o.open_lines && o.open_lines < lines.length ? `，${o.open_lines} 行未结束` : ''}）</h3>
        <div class="lines-wrap"><table class="lines"><thead><tr><th>零件号</th><th class="desc">描述</th><th class="num">数量</th><th class="num up">单价</th><th class="num amt-l">金额</th><th>交期</th><th class="cpo">客户 PO / Line</th><th>发货</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table></div>
      </div>
    </div>`;
}

function detail(o) {
  if (isTracker(o)) return trackerDetail(o);
  const facts = [];
  const add = (k, v) => v && facts.push(`<span>${esc(k)} <b>${esc(v)}</b></span>`);
  add('下单', fmtDay(o.order_date));
  add('交期原文', o.due_text && o.due_text !== fmtDay(o.due_date) ? o.due_text : '');
  add('客户交期', fmtDay(o.customer_due));
  add('下单主体', o.buyer_entity);
  add('客户', o.customer);
  add('运单号', o.tracking);
  add('最近邮件', fmtDateTime(o.last_mail_at));
  add('整理于', fmtDateTime(o.updated_at));
  const fixed = (o.overridden || []).length ? `<span class="tag-fixed" title="${esc(o.overridden.join('、'))}">手工更正过</span>` : '';

  const lines = o.lines || [];
  const linesHtml = lines.length
    ? `<table class="lines"><thead><tr><th>零件号</th><th>Rev</th><th class="desc">描述</th><th class="num">数量</th><th class="num">单价</th><th class="num">金额</th></tr></thead><tbody>${lines
        .map(
          (l) =>
            `<tr><td class="pn">${esc(l.pn)}</td><td>${esc(l.rev)}</td><td class="desc">${esc(l.desc)}</td><td class="num">${esc(num(l.qty))}</td><td class="num">${esc(num(l.unit_price))}</td><td class="num">${esc(num(l.amount))}</td></tr>`,
        )
        .join('')}</tbody></table>`
    : '<p class="muted">邮件里没读到零件明细。</p>';


  const mails = o.mails || [];
  const mailsHtml = mails.length
    ? `<ul class="mails">${mails
        .map(
          (m) =>
            `<li><span class="when">${esc(fmtDateTime(m.date))}</span><span class="who" title="${esc(m.from)}">${esc(m.from)}</span><span class="subj">${esc(m.subject)} <span class="muted">${esc(m.folder || '')}${m.uid ? ` #${esc(m.uid)}` : ''}</span></span></li>`,
        )
        .join('')}</ul>`
    : '<p class="muted">没有。</p>';

  return `<div class="dl">
      <div class="facts">${facts.join('')}${fixed}</div>
      <div><h3>零件明细（${lines.length} 行）</h3>${linesHtml}</div>
      <div>
        ${o.status_note ? `<h3>状态依据</h3><p class="muted">${esc(o.status_note)}</p>` : ''}
        <h3>相关邮件（${mails.length}）</h3>${mailsHtml}
      </div>
    </div>`;
}

function render() {
  const q = state.q.trim().toLowerCase();
  const terms = q ? q.split(/\s+/) : [];
  const base = state.orders.filter((o) => {
    if (state.supplier !== '__all' && supplierOf(o) !== (state.supplier === '__none' ? '' : state.supplier)) return false;
    return terms.every((t) => haystack(o).includes(t));
  });
  const counts = { all: base.length };
  for (const o of base) counts[o._u.key] = (counts[o._u.key] || 0) + 1;
  counts.open = base.length - (counts.done || 0);
  renderChips(counts);

  const keep = (o) => state.level === 'all' || (state.level === 'open' ? o._u.key !== 'done' : o._u.key === state.level);
  const list = base.filter(keep).sort(SORTS[state.sort] || SORTS.urgency);
  $('rows').innerHTML = list
    .map((o) => {
      const open = state.open.has(rowKey(o));
      const row = `<tr class="row u-${o._u.key}" data-key="${esc(rowKey(o))}" tabindex="0" aria-expanded="${open}">${cells(o)}</tr>`;
      return open ? `${row}<tr class="detail u-${o._u.key}"><td colspan="8">${detail(o)}</td></tr>` : row;
    })
    .join('');

  document.querySelectorAll('.grid th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === state.sort));
  $('sort').value = state.sort;

  const empty = $('empty');
  if (!state.orders.length) {
    empty.hidden = false;
    empty.textContent = state.meta.missing ? '还没有数据：点右上角「上传总表」把跟单总表传上来。' : state.meta.error || '表里还没有 PO。';
  } else if (!list.length) {
    empty.hidden = false;
    empty.textContent = '没有符合条件的 PO。';
  } else {
    empty.hidden = true;
  }
  $('count').textContent = state.orders.length ? `显示 ${list.length} / ${state.orders.length} 个 PO` : '';
}

function renderHeader() {
  const m = state.meta;
  const tracker = m.source === 'tracker';
  document.querySelector('.grid th.c-status').textContent = tracker ? '跟单备注' : '状态';
  $('src').textContent = tracker
    ? '数据来自跟单人员上传的跟单总表（订单明细）：备注、预计发货、发货日期都是表里人填的原文；备注写「完成」、含「取消」或填了发货日期的行算结束。'
    : '数据从 zill@kvstek.com 的 PO 邮件整理。';
  $('upload').hidden = false;
  $('logout').hidden = !m.can_logout;
  if (tracker) return renderTrackerHeader(m);
  const when = fmtDateTime(m.generated_at || m.file_mtime);
  $('sub').textContent = m.missing
    ? 'zill@kvstek.com 的 PO 邮件 · 数据还没生成'
    : `zill@kvstek.com 的 PO 邮件 · 更新于 ${when || '—'} · 共 ${state.orders.length} 个 PO`;
  const gen = new Date(m.generated_at || m.file_mtime || NaN);
  const now = new Date(m.server_time || Date.now());
  const hours = (now - gen) / 36e5;
  const stale = $('stale');
  if (!isNaN(hours) && hours > 3) {
    stale.hidden = false;
    stale.textContent = `数据已经 ${Math.floor(hours)} 小时没更新了（正常每小时一次），可能是 Mac 没开或同步出错，列表可能不是最新的。`;
  } else {
    stale.hidden = true;
  }
}

function renderTrackerHeader(m) {
  const sheet = m.sheet_note ? m.sheet_note.replace(/^最后更新时间\s*/, '表内更新 ') : m.filename || '';
  $('sub').textContent = [`跟单总表 ${fmtDateTime(m.uploaded_at)} 上传`, sheet, `共 ${state.orders.length} 个 PO`].filter(Boolean).join(' · ');
  const up = new Date(m.uploaded_at || NaN);
  const now = new Date(m.server_time || Date.now());
  const days = Math.floor((now - up) / 864e5);
  const stale = $('stale');
  stale.hidden = !(days >= 2);
  if (!stale.hidden) stale.textContent = `跟单总表已经 ${days} 天没上传了，下面是 ${md(up)} 那份的内容。`;
}

// ---------------------------------------------------------------- 上传跟单总表

function b64utf8(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

function openUpload() {
  const dlg = $('up-dialog');
  $('up-msg').textContent = state.meta.upload_ready ? '' : '还没有设上传密码，请 Zane 先在 Mac 上设一下。';
  $('up-msg').className = state.meta.upload_ready ? 'up-msg' : 'up-msg bad';
  $('up-go').disabled = false;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
  $('up-file').focus();
}

async function doUpload(e) {
  e.preventDefault();
  const file = $('up-file').files[0];
  const msg = $('up-msg');
  const say = (text, cls) => {
    msg.textContent = text;
    msg.className = `up-msg ${cls || ''}`;
  };
  if (!file) return say('先选一个 .xlsx 文件。', 'bad');
  if (!/\.xlsx$/i.test(file.name)) return say('只能上传 .xlsx（.xls 或 .xlsm 请在 Excel 里另存为 .xlsx）。', 'bad');
  const pw = $('up-key').value;
  if (!pw) return say('请输入上传密码。', 'bad');
  $('up-go').disabled = true;
  say('正在上传和读取…');
  try {
    const r = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/octet-stream', 'X-Upload-Key': b64utf8(pw), 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    });
    let doc = {};
    try {
      doc = await r.json();
    } catch (err) {
      /* 不是 JSON 就用状态码 */
    }
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    if (!r.ok) throw new Error(doc.error || `HTTP ${r.status}`);
    $('up-key').value = '';
    say(`已更新：${doc.wo_count} 个 PO，其中 ${doc.open_count} 个未完成（共 ${doc.rows} 行）。`, 'good');
    await load();
  } catch (err) {
    say(`没有更新：${err.message || err}`, 'bad');
  } finally {
    $('up-go').disabled = false;
  }
}

// ---------------------------------------------------------------- 读数据

async function load() {
  const btn = $('refresh');
  btn.disabled = true;
  try {
    const r = await fetch('/api/orders', { cache: 'no-store', credentials: 'same-origin' });
    if (r.status === 401) {
      location.href = '/login';
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const doc = await r.json();
    state.meta = doc.meta || {};
    state.orders = (doc.orders || []).filter((o) => o && o.po);
    for (const o of state.orders) o._u = classify(o);
    state.loadedAt = Date.now();
    renderHeader();
    renderSuppliers();
    render();
  } catch (e) {
    $('sub').textContent = `读取失败：${e.message || e}，稍后点「刷新」再试`;
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- 交互

function toggleRow(tr) {
  const key = tr.dataset.key;
  if (state.open.has(key)) state.open.delete(key);
  else state.open.add(key);
  render();
  const again = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
  if (again) again.focus({ preventScroll: true });
}

function init() {
  loadPrefs();
  $('chips').addEventListener('click', (e) => {
    const b = e.target.closest('.chip');
    if (!b) return;
    state.level = b.dataset.level;
    savePrefs();
    render();
  });
  let t = 0;
  $('q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => {
      state.q = e.target.value;
      render();
    }, 120);
  });
  $('supplier').addEventListener('change', (e) => {
    state.supplier = e.target.value;
    savePrefs();
    render();
  });
  $('sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    savePrefs();
    render();
  });
  document.querySelector('.grid thead').addEventListener('click', (e) => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    state.sort = state.sort === th.dataset.sort ? 'urgency' : th.dataset.sort;
    savePrefs();
    render();
  });
  $('rows').addEventListener('click', (e) => {
    if (e.target.closest('tr.detail')) return;
    const tr = e.target.closest('tr.row');
    if (tr && !window.getSelection().toString()) toggleRow(tr);
  });
  $('rows').addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr.row');
    if (tr && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggleRow(tr);
    }
  });
  $('refresh').addEventListener('click', load);
  $('upload').addEventListener('click', openUpload);
  $('up-form').addEventListener('submit', doUpload);
  $('up-cancel').addEventListener('click', () => $('up-dialog').close());
  // 每 5 分钟自动刷新；切回这个标签页时，超过 1 分钟没读就重读
  setInterval(() => document.visibilityState === 'visible' && load(), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 60 * 1000) load();
  });
  load();
}

init();
