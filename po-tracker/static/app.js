'use strict';
// PO 跟单列表页：读 /api/orders，按供应商交期的紧急程度上色、筛选、排序；点一行展开零件明细和相关邮件。

const RED_DAYS = 3; // 0–3 天：红
const AMBER_DAYS = 7; // 4–7 天：黄
const DONE = new Set(['已发货', '已完成', '已取消']);
const LEVELS = [
  { key: 'all', label: '全部' },
  { key: 'overdue', label: '逾期' },
  { key: 'red', label: '3 天内' },
  { key: 'amber', label: '7 天内' },
  { key: 'green', label: '7 天以上' },
  { key: 'nodate', label: '没写交期' },
  { key: 'done', label: '已发货 / 完成' },
];
const RANK = { overdue: 0, red: 1, amber: 2, green: 3, nodate: 4, done: 5 };
const WEEK = '日一二三四五六';
const PREF_KEY = 'po-tracker-prefs';

const $ = (id) => document.getElementById(id);
const state = {
  orders: [],
  meta: {},
  level: 'all',
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
  if (DONE.has(o.status)) return { key: 'done', pill: o.status, days: null };
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
    const parts = [o.po, ...(o.aliases || []), o.supplier, o.customer_po, o.customer, o.end_user, o.status, o.status_note, o.tracking, o.due_text];
    for (const l of o.lines || []) parts.push(l.pn, l.rev, l.desc);
    for (const t of o.open_issues || []) parts.push(t);
    h = parts.filter(Boolean).join(' ').toLowerCase();
    haystacks.set(o, h);
  }
  return h;
}

function supplierOf(o) {
  return o.supplier || '';
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
  const issues = (o.open_issues || []).filter(Boolean);
  const amt = money(o.amount, o.currency);
  return `
    <td class="c-due">${dueHtml}${due ? '<br>' : ''}<span class="pill">${esc(u.pill)}</span></td>
    <td class="c-po"><span class="po">${esc(o.po)}</span><span class="po-sup">${esc(o.supplier || '供应商未定')}</span>${aliases.length ? `<span class="alias">原 ${esc(aliases.join('、'))}</span>` : ''}</td>
    <td class="c-sup">${o.supplier ? esc(o.supplier) : '<span class="none">未定</span>'}</td>
    <td class="c-status"><span class="st st-${esc(o.status || '')}">${esc(o.status || '—')}</span>${o.status_note ? `<span class="muted st-note clip">${esc(o.status_note)}</span>` : ''}</td>
    <td class="c-cust"><span>${o.customer_po ? esc(o.customer_po) : '<span class="none">—</span>'}</span>${o.end_user ? `<span class="muted">${esc(o.end_user)}</span>` : ''}</td>
    <td class="c-lines">${lines.length ? `${lines.length} 行<div class="muted">${esc(lines[0].pn || lines[0].desc || '')}${lines.length > 1 ? ' 等' : ''}</div>` : '<span class="none">—</span>'}</td>
    <td class="c-amt">${amt ? `<span class="amt">${esc(amt)}</span>${o.tax ? `<div class="tax">${esc(o.tax)}</div>` : ''}` : '<span class="none">—</span>'}</td>
    <td class="c-ord">${o.order_date ? esc(fmtDay(o.order_date)) : '<span class="none">—</span>'}</td>
    <td class="c-issue">${issues.length ? `<span class="issue-n">${issues.length}</span><span class="issue-text">${esc(issues[0])}</span>` : '<span class="none">—</span>'}</td>`;
}

function detail(o) {
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

  const issues = (o.open_issues || []).filter(Boolean);
  const issuesHtml = issues.length ? `<ul class="issues">${issues.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : '<p class="muted">没有。</p>';

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
        <h3>待跟进</h3>${issuesHtml}
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
  renderChips(counts);

  const list = base.filter((o) => state.level === 'all' || o._u.key === state.level).sort(SORTS[state.sort] || SORTS.urgency);
  $('rows').innerHTML = list
    .map((o) => {
      const open = state.open.has(o.po);
      const row = `<tr class="row u-${o._u.key}" data-po="${esc(o.po)}" tabindex="0" aria-expanded="${open}">${cells(o)}</tr>`;
      return open ? `${row}<tr class="detail u-${o._u.key}"><td colspan="9">${detail(o)}</td></tr>` : row;
    })
    .join('');

  document.querySelectorAll('.grid th[data-sort]').forEach((th) => th.classList.toggle('sorted', th.dataset.sort === state.sort));
  $('sort').value = state.sort;

  const empty = $('empty');
  if (!state.orders.length) {
    empty.hidden = false;
    empty.textContent = state.meta.missing ? '还没有数据：等第一次从邮箱整理完就会出现。' : state.meta.error || '邮箱里还没找到 PO。';
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
  const when = fmtDateTime(m.generated_at || m.file_mtime);
  $('sub').textContent = m.missing
    ? 'zill@kvstek.com 的 PO 邮件 · 数据还没生成'
    : `zill@kvstek.com 的 PO 邮件 · 更新于 ${when || '—'} · 共 ${state.orders.length} 个 PO`;
  $('logout').hidden = !m.can_logout;
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
  const po = tr.dataset.po;
  if (state.open.has(po)) state.open.delete(po);
  else state.open.add(po);
  render();
  const again = document.querySelector(`tr.row[data-po="${CSS.escape(po)}"]`);
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
  // 每 5 分钟自动刷新；切回这个标签页时，超过 1 分钟没读就重读
  setInterval(() => document.visibilityState === 'visible' && load(), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 60 * 1000) load();
  });
  load();
}

init();
