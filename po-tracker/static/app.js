'use strict';
// PO 跟单列表页：读 /api/orders，按供应商交期的紧急程度上色、筛选、排序；点一行展开零件明细、相关邮件和跟进记录。
// 状态最初从 zill@ 邮件整理，之后由跟单的人在展开的表单里改（要编辑密码；本机直接打开不用）。

const RED_DAYS = 3; // 0–3 天：红
const AMBER_DAYS = 7; // 4–7 天：黄
const STATUSES = ['未定', '已下单', '已确认', '已发货', '已完成', '已取消'];
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
const NAME_KEY = 'po-tracker-name';
const FIELD_LABEL = { status: '状态', due_date: '交期', eta: '预计发货', tracking: '运单号' };
const EDIT_FIELDS = ['status', 'due_date', 'eta', 'tracking'];

const $ = (id) => document.getElementById(id);
const state = {
  orders: [],
  meta: {},
  level: 'open',
  supplier: '__all',
  q: '',
  sort: 'urgency',
  open: new Set(),
  drafts: new Map(), // 展开后填了还没保存的内容，重新渲染时不丢
  loadedAt: 0,
  me: '',
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

// 预计发货可以是日期，也可以是「随时」「待定」这种字
function dayOrText(s) {
  return parseDay(s) ? fmtDay(s) : s || '';
}

function money(amount, currency) {
  if (amount === null || amount === undefined || amount === '' || isNaN(+amount)) return '';
  const sym = currency === 'USD' ? '$' : currency === 'RMB' || currency === 'CNY' ? '¥' : '';
  return sym + (+amount).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function num(v) {
  return v === null || v === undefined || v === '' ? '' : (+v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch (e) {
    /* 隐私模式等读写不了就算了 */
  }
  return null;
}

function loadPrefs() {
  try {
    const p = JSON.parse(store(PREF_KEY) || '{}');
    if (typeof p.level === 'string') state.level = p.level;
    if (typeof p.supplier === 'string') state.supplier = p.supplier;
    if (typeof p.sort === 'string') state.sort = p.sort;
  } catch (e) {
    /* 用默认 */
  }
  state.me = store(NAME_KEY) || '';
}

function savePrefs() {
  store(PREF_KEY, JSON.stringify({ level: state.level, supplier: state.supplier, sort: state.sort }));
}

async function postJSON(url, obj) {
  const r = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj || {}),
  });
  let doc = {};
  try {
    doc = await r.json();
  } catch (e) {
    /* 不是 JSON 就看状态码 */
  }
  if (r.status === 401) {
    location.href = '/login';
    throw new Error('需要重新登录');
  }
  if (!r.ok) throw new Error(doc.error || `HTTP ${r.status}`);
  return doc;
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
    const parts = [o.po, ...(o.aliases || []), o.supplier, o.customer_po, o.customer, o.end_user, o.status, o.status_note, o.tracking, o.due_text, o.note, o.eta];
    for (const l of o.lines || []) parts.push(l.pn, l.rev, l.desc);
    h = parts.filter(Boolean).join(' ').toLowerCase();
    haystacks.set(o, h);
  }
  return h;
}

function supplierOf(o) {
  return o.supplier || '';
}

// 同一个 PO 号偶尔会给两家供应商用（如 44278），所以用「PO 号|供应商」当键（服务器给的 key 也是这个）
function rowKey(o) {
  return o.key || `${o.po}|${supplierOf(o)}`;
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

// ---------------------------------------------------------------- 渲染：列表

function renderChips(counts) {
  $('chips').innerHTML = LEVELS.map((lv) => {
    const n = counts[lv.key] || 0;
    const cls = ['chip', lv.key === 'all' || lv.key === 'open' ? '' : `u-${lv.key}`, n ? '' : 'zero'].join(' ');
    const dot = lv.key === 'all' || lv.key === 'open' ? '' : '<span class="dot"></span>';
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
  $('sup-list').innerHTML = names.filter(Boolean).map((n) => `<option value="${esc(n)}"></option>`).join('');
}

function statusCell(o) {
  const parts = [`<span class="st st-${esc(o.status || '')}">${esc(o.status || '—')}</span>`];
  if (o.note) {
    parts.push(`<span class="note clip" title="${esc(o.note)}">${esc(o.note)}</span>`);
    parts.push(`<span class="muted">${esc([o.note_by, fmtDateTime(o.note_at)].filter(Boolean).join(' '))}</span>`);
  } else if (o.status_note) {
    parts.push(`<span class="muted st-note clip">${esc(o.status_note)}</span>`);
  }
  const extra = [o.eta && `预计发货 ${dayOrText(o.eta)}`, o.tracking && `运单 ${o.tracking}`].filter(Boolean);
  if (extra.length) parts.push(`<span class="eta">${esc(extra.join(' · '))}</span>`);
  const total = (o.lines || []).length;
  if (!DONE.has(o.status) && typeof o.open_lines === 'number' && total > 1 && o.open_lines < total) {
    parts.push(`<span class="muted">${total - o.open_lines}/${total} 行已结束</span>`);
  }
  return parts.join('');
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
  const manual = o.source === 'manual' ? '<span class="tag-manual" title="网页上手动加的">手动</span>' : '';
  return `
    <td class="c-due">${dueHtml}${due ? '<br>' : ''}<span class="pill">${esc(u.pill)}</span></td>
    <td class="c-po"><span class="po">${esc(o.po)}</span>${manual}<span class="po-sup">${esc(o.supplier || '供应商未定')}</span>${aliases.length ? `<span class="alias">原 ${esc(aliases.join('、'))}</span>` : ''}</td>
    <td class="c-sup">${o.supplier ? esc(o.supplier) : '<span class="none">未定</span>'}</td>
    <td class="c-status">${statusCell(o)}</td>
    <td class="c-cust"><span>${o.customer_po ? esc(o.customer_po) : '<span class="none">—</span>'}</span>${o.end_user ? `<span class="muted">${esc(o.end_user)}</span>` : ''}</td>
    <td class="c-lines">${lines.length ? `${lines.length} 行<div class="muted">${esc(lines[0].pn || lines[0].desc || '')}${lines.length > 1 ? ' 等' : ''}</div>` : '<span class="none">—</span>'}</td>
    <td class="c-amt">${amt ? `<span class="amt">${esc(amt)}</span>${o.tax ? `<div class="tax">${esc(o.tax)}</div>` : ''}` : '<span class="none">—</span>'}</td>
    <td class="c-ord">${o.order_date ? esc(fmtDay(o.order_date)) : '<span class="none">—</span>'}</td>`;
}

// ---------------------------------------------------------------- 渲染：展开

function fmtValue(field, v) {
  if (!v) return '空';
  return field === 'due_date' ? fmtDay(v) : field === 'eta' ? dayOrText(v) : v;
}

function historyHtml(o) {
  const hist = o.history || [];
  const items = hist.map((h) => {
    const what = [];
    if (h.action === 'add') what.push('新增这个 PO');
    for (const [f, [a, b]] of Object.entries(h.changes || {})) {
      what.push(`${FIELD_LABEL[f] || f} ${esc(fmtValue(f, a))} → <b>${esc(fmtValue(f, b))}</b>`);
    }
    const note = h.note ? `<div class="h-note">${esc(h.note)}</div>` : '';
    return `<li><span class="when">${esc(fmtDateTime(h.at))}</span><span class="who">${esc(h.by)}</span><span class="what">${what.join('；')}${note}</span></li>`;
  });
  let origin = '';
  if (o.source === 'tracker') {
    origin = `<li class="h-origin"><span class="when">${esc(fmtDateTime(state.meta.generated_at))}</span><span class="who">总表</span><span class="what">从${esc(state.meta.sheet_label || '跟单总表')}导入：状态 <b>${esc(firstStatus(o))}</b></span></li>`;
  } else if (o.source !== 'manual') {
    const when = state.meta.mail_generated_at || state.meta.generated_at;
    origin = `<li class="h-origin"><span class="when">${esc(fmtDateTime(when))}</span><span class="who">邮件</span><span class="what">从 zill@ 邮件整理：状态 <b>${esc(firstStatus(o))}</b>${o.status_note ? `<div class="h-note">${esc(o.status_note)}</div>` : ''}</span></li>`;
  }
  return `<ul class="hist">${items.join('')}${origin}</ul>`;
}

// 被网页改过状态时，邮件整理的原始状态 = 最早一条改状态记录里的「旧」值
function firstStatus(o) {
  const hist = o.history || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const c = hist[i].changes && hist[i].changes.status;
    if (c) return c[0] || '—';
  }
  return o.status || '—';
}

function editForm(o) {
  const key = rowKey(o);
  const d = state.drafts.get(key) || {};
  const val = (f) => (f in d ? d[f] : o[f] || '');
  const statusOpts = STATUSES.map((s) => `<option${val('status') === s ? ' selected' : ''}>${esc(s)}</option>`).join('');
  return `<form class="fu-form" data-key="${esc(key)}" autocomplete="off">
      <div class="fu-grid">
        <label>状态<select name="status">${statusOpts}</select></label>
        <label>供应商交期<input type="date" name="due_date" value="${esc(val('due_date'))}" /></label>
        <label>预计发货<input name="eta" maxlength="40" placeholder="日期或「随时」" value="${esc(val('eta'))}" /></label>
        <label>运单号<input name="tracking" maxlength="80" value="${esc(val('tracking'))}" /></label>
      </div>
      <label class="fu-note">这次跟进了什么<textarea name="note" rows="2" maxlength="500" placeholder="例如：凯维说 11/20 发货">${esc(d.note || '')}</textarea></label>
      <div class="fu-actions">
        <label class="fu-by">你的名字<input name="by" maxlength="20" value="${esc(state.me)}" /></label>
        <button type="submit" class="btn btn-primary">保存</button>
        <span class="fu-msg" role="status"></span>
        ${o.source === 'manual' ? '<button type="button" class="btn-link danger" data-act="delete">删除这个手动加的 PO</button>' : ''}
      </div>
    </form>`;
}

// 总表导入的行带交期、发货、备注，多显示三列；结束的行变灰
function linesTable(lines) {
  const rich = lines.some((l) => l.wo_due || l.shipped || l.eta || l.note);
  const head = `<tr><th>零件号</th><th class="desc">描述</th><th class="num">数量</th><th class="num up">单价</th><th class="num">金额</th>${
    rich ? '<th>交期</th><th>发货</th><th>备注</th>' : ''
  }</tr>`;
  const body = lines
    .map((l) => {
      const pn = `${esc(l.pn)}${l.rev ? ` <span class="muted">${esc(l.rev)}</span>` : ''}`;
      const ship = l.shipped ? `已发 ${esc(fmtDay(l.shipped))}` : l.eta ? `预计 ${esc(dayOrText(l.eta))}` : '';
      const extra = [l.customer_po && `客户 PO ${l.customer_po}${l.customer_line ? ` / ${l.customer_line}` : ''}`, l.next_step && `下一站 ${l.next_step}`, l.invoice && `Invoice ${l.invoice}`].filter(Boolean);
      const richCells = rich
        ? `<td class="nowrap" data-label="交期 ">${esc(fmtDay(l.wo_due))}</td><td class="nowrap ship-l">${ship}</td><td class="ln-note">${esc(l.note)}${extra.length ? `<div class="muted">${esc(extra.join(' · '))}</div>` : ''}</td>`
        : '';
      return `<tr class="${l.closed ? 'ln-closed' : ''}"><td class="pn">${pn}</td><td class="desc">${esc(l.desc)}</td><td class="num" data-label="数量 ">${esc(num(l.qty))}</td><td class="num up">${esc(num(l.unit_price))}</td><td class="num amt-l">${esc(num(l.amount))}</td>${richCells}</tr>`;
    })
    .join('');
  return `<div class="lines-wrap${rich ? ' rich' : ''}"><table class="lines"><thead>${head}</thead><tbody>${body}</tbody></table></div>`;
}

function detail(o) {
  const facts = [];
  const add = (k, v) => v && facts.push(`<span>${esc(k)} <b>${esc(v)}</b></span>`);
  add('下单', fmtDay(o.order_date));
  add(o.source === 'tracker' ? '各行交期' : '交期原文', o.due_text && o.due_text !== fmtDay(o.due_date) ? o.due_text : '');
  add('客户交期', fmtDay(o.customer_due));
  add('下单主体', o.buyer_entity);
  add('客户', o.customer);
  add('已发货', (o.shipped || []).map(fmtDay).join('、'));
  add('邮件里是', o.mail_status && o.mail_status !== firstStatus(o) ? o.mail_status : '');
  add('旧号', (o.aliases || []).join('、'));
  add('最近邮件', fmtDateTime(o.last_mail_at));
  add('手动新增', o.source === 'manual' ? [o.created_by, fmtDateTime(o.created_at)].filter(Boolean).join(' ') : '');
  const fixed = (o.overridden || []).length ? `<span class="tag-fixed" title="${esc(o.overridden.join('、'))}">手工更正过</span>` : '';

  const lines = o.lines || [];
  const linesHtml = lines.length ? linesTable(lines) : '<p class="muted">没有零件明细。</p>';

  const mails = o.mails || [];
  const mailsHtml = mails.length
    ? `<h3>相关邮件（${mails.length}）</h3><ul class="mails">${mails
        .map(
          (m) =>
            `<li><span class="when">${esc(fmtDateTime(m.date))}</span><span class="who" title="${esc(m.from)}">${esc(m.from)}</span><span class="subj">${esc(m.subject)} <span class="muted">${esc(m.folder || '')}${m.uid ? ` #${esc(m.uid)}` : ''}</span></span></li>`,
        )
        .join('')}</ul>`
    : '';

  const canEdit = !!state.meta.can_edit;
  const lockHint = canEdit ? '' : '<p class="muted">要改状态或写跟进，点右上角「编辑」输编辑密码。</p>';
  return `<div class="dl">
      <div class="facts">${facts.join('')}${fixed}</div>
      <div class="fu">
        <h3>跟进</h3>
        ${canEdit ? editForm(o) : lockHint}
        <h3>跟进记录</h3>${historyHtml(o)}
      </div>
      <div class="parts">
        <h3>零件明细（${lines.length} 行）</h3>${linesHtml}
        ${mailsHtml}
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
    empty.textContent = state.meta.missing ? '还没有数据。' : state.meta.error || '还没有 PO。';
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
  const parts = [];
  if (m.base === 'tracker') parts.push(`${fmtDateTime(m.generated_at)} 导入${m.sheet_label || '跟单总表'}`);
  else if (m.generated_at) parts.push(`${fmtDateTime(m.generated_at)} 从邮件整理`);
  if (m.last_edit) parts.push(`最近跟进 ${fmtDateTime(m.last_edit.at)} ${m.last_edit.by || ''}`.trim());
  parts.push(`共 ${state.orders.length} 个 PO`);
  $('sub').textContent = parts.join(' · ');
  $('logout').hidden = !m.can_logout;
  $('add').hidden = !m.can_edit;
  $('edit').hidden = !!m.can_edit;
  $('edit-off').hidden = !m.can_edit || !!m.edit_local;
  const stale = $('stale');
  stale.hidden = !m.edit_error;
  stale.textContent = m.edit_error || '';
}

// ---------------------------------------------------------------- 读数据

function busy() {
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('.fu-form, dialog[open]')) || !!document.querySelector('dialog[open]');
}

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

// ---------------------------------------------------------------- 跟进表单

function formMsg(form, text, cls) {
  const el = form.querySelector('.fu-msg');
  el.textContent = text;
  el.className = `fu-msg ${cls || ''}`;
}

async function saveFollowUp(form) {
  const key = form.dataset.key;
  const o = state.orders.find((x) => rowKey(x) === key);
  if (!o) return formMsg(form, '这个 PO 找不到了，请刷新', 'bad');
  const by = form.by.value.trim();
  if (!by) {
    form.by.focus();
    return formMsg(form, '先填你的名字', 'bad');
  }
  const changes = {};
  for (const f of EDIT_FIELDS) {
    const v = form[f].value.trim();
    if (v !== (o[f] || '')) changes[f] = v;
  }
  const note = form.note.value.trim();
  if (!note && !Object.keys(changes).length) return formMsg(form, '没有改动', 'bad');
  const btn = form.querySelector('button[type="submit"]');
  btn.disabled = true;
  formMsg(form, '正在保存…');
  try {
    await postJSON('/api/order/update', { key, by, changes, note });
    state.drafts.delete(key);
    await load();
    const again = document.querySelector(`form.fu-form[data-key="${CSS.escape(key)}"]`);
    if (again) formMsg(again, '已保存', 'good');
    else {
      const now = state.orders.find((x) => rowKey(x) === key);
      const where = now ? LEVELS.find((lv) => lv.key === now._u.key) : null;
      toast(`已保存 ${o.po}（${o.supplier || '供应商未定'}）${where ? `，现在在「${where.label}」里` : ''}`);
    }
  } catch (e) {
    formMsg(form, `没保存：${e.message || e}`, 'bad');
    btn.disabled = false;
  }
}

async function deleteManual(form) {
  const key = form.dataset.key;
  const by = form.by.value.trim();
  if (!by) return formMsg(form, '先填你的名字', 'bad');
  if (!confirm(`删除手动加的 ${key.replace('|', '（')}）？跟进记录会留着，但列表里就看不到了。`)) return;
  try {
    await postJSON('/api/order/delete', { key, by });
    state.drafts.delete(key);
    state.open.delete(key);
    await load();
  } catch (e) {
    formMsg(form, `没删掉：${e.message || e}`, 'bad');
  }
}

let toastTimer = 0;
function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

// ---------------------------------------------------------------- 编辑密码、新增 PO

function showDialog(id) {
  const dlg = $(id);
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

function dialogMsg(id, text, cls) {
  const el = $(id);
  el.textContent = text;
  el.className = `dlg-msg ${cls || ''}`;
}

function openEditLogin() {
  dialogMsg('ed-msg', state.meta.edit_ready ? '' : '还没有设编辑密码，请 Zane 先在 Mac 上设一下。', state.meta.edit_ready ? '' : 'bad');
  $('ed-key').value = '';
  showDialog('ed-dialog');
  $('ed-key').focus();
}

async function doEditLogin(e) {
  e.preventDefault();
  const pw = $('ed-key').value;
  if (!pw) return dialogMsg('ed-msg', '请输入编辑密码。', 'bad');
  $('ed-go').disabled = true;
  try {
    await postJSON('/api/edit-login', { password: pw });
    $('ed-key').value = '';
    $('ed-dialog').close();
    await load();
  } catch (err) {
    dialogMsg('ed-msg', err.message || String(err), 'bad');
  } finally {
    $('ed-go').disabled = false;
  }
}

async function editLogout() {
  try {
    await postJSON('/api/edit-logout', {});
  } catch (e) {
    /* 照样刷新 */
  }
  await load();
}

function openAdd() {
  const f = $('add-form');
  f.reset();
  f.by.value = state.me;
  dialogMsg('add-msg', '');
  showDialog('add-dialog');
  f.po.focus();
}

function parseLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const m = /^\s*(\S+)(?:\s+[x×*]?\s*(\d+(?:\.\d+)?))?\s*$/i.exec(raw);
    if (m) out.push({ pn: m[1], qty: m[2] ? +m[2] : null });
    else if (raw.trim()) out.push({ pn: raw.trim().split(/\s+/)[0], qty: null });
  }
  return out;
}

async function doAdd(e) {
  e.preventDefault();
  const f = $('add-form');
  const by = f.by.value.trim();
  if (!by) return dialogMsg('add-msg', '先填你的名字。', 'bad');
  state.me = by;
  store(NAME_KEY, by);
  const order = {
    po: f.po.value.trim(),
    supplier: f.supplier.value.trim(),
    status: f.status.value,
    order_date: f.order_date.value,
    due_date: f.due_date.value,
    customer_po: f.customer_po.value.trim(),
    end_user: f.end_user.value.trim(),
    amount: f.amount.value.trim(),
    lines: parseLines(f.lines.value),
    note: f.note.value.trim(),
  };
  $('add-go').disabled = true;
  try {
    await postJSON('/api/order/add', { by, order });
    const key = `${order.po}|${order.supplier}`;
    $('add-dialog').close();
    state.open.add(key);
    state.q = '';
    $('q').value = '';
    await load();
    const tr = document.querySelector(`tr.row[data-key="${CSS.escape(key)}"]`);
    if (tr) tr.scrollIntoView({ block: 'center' });
  } catch (err) {
    dialogMsg('add-msg', err.message || String(err), 'bad');
  } finally {
    $('add-go').disabled = false;
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
  $('add-form').status.innerHTML = STATUSES.map((s) => `<option${s === '已下单' ? ' selected' : ''}>${esc(s)}</option>`).join('');
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
  const rows = $('rows');
  rows.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act="delete"]');
    if (act) return deleteManual(act.closest('form'));
    if (e.target.closest('tr.detail')) return;
    const tr = e.target.closest('tr.row');
    if (tr && !window.getSelection().toString()) toggleRow(tr);
  });
  rows.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr.row');
    if (tr && e.target === tr && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggleRow(tr);
    }
  });
  rows.addEventListener('input', (e) => {
    const form = e.target.closest('form.fu-form');
    if (!form || !e.target.name) return;
    if (e.target.name === 'by') {
      state.me = e.target.value.trim();
      store(NAME_KEY, state.me);
      return;
    }
    const d = state.drafts.get(form.dataset.key) || {};
    d[e.target.name] = e.target.value;
    state.drafts.set(form.dataset.key, d);
  });
  rows.addEventListener('submit', (e) => {
    const form = e.target.closest('form.fu-form');
    if (!form) return;
    e.preventDefault();
    saveFollowUp(form);
  });
  $('refresh').addEventListener('click', load);
  $('edit').addEventListener('click', openEditLogin);
  $('edit-off').addEventListener('click', editLogout);
  $('add').addEventListener('click', openAdd);
  $('ed-form').addEventListener('submit', doEditLogin);
  $('ed-cancel').addEventListener('click', () => $('ed-dialog').close());
  $('add-form').addEventListener('submit', doAdd);
  $('add-cancel').addEventListener('click', () => $('add-dialog').close());
  // 每 5 分钟自动刷新（正在填跟进或开着对话框时跳过）；切回这个标签页时，超过 1 分钟没读就重读
  setInterval(() => document.visibilityState === 'visible' && !busy() && load(), 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > 60 * 1000 && !busy()) load();
  });
  load();
}

init();
