'use strict';
// ---------------------------------------------------------------- 做采购订单
// 展开一个 PO →「做采购订单」→ 预览（版式照 Zane 11-15 给的样张，都能改）→ 导出 Excel / 打印（存 PDF）。保存时服务器重新算钱，
// 记进 data/purchases.json；供方全称和地址电话税号记下来，下次同一家自动带出。
// Zane 11-15：Tony 的 PO 价都是含税价，所以带出来的单价 = 含税单价 ÷ (1 + 税率)，四舍五入到分。字体全用等线。
// 用 app.js 里的 state、$、esc、postJSON、store、NAME_KEY、load 等。

const PUR_DIGITS = '零壹贰叁肆伍陆柒捌玖';

function purCfg() {
  return state.meta.purchase || {};
}

function purNum(v) {
  if (v === '' || v === null || v === undefined) return NaN;
  return Number(String(v).replace(/[,¥\s%]/g, ''));
}

function cents(x) {
  return Math.round(x * 100 + (x >= 0 ? 1e-6 : -1e-6));
}

function fmtYuan(c) {
  return Number.isFinite(c) ? `¥${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
}

function four(n) {
  let s = '';
  let zero = false;
  [[1000, '仟'], [100, '佰'], [10, '拾'], [1, '']].forEach(([i, u]) => {
    const d = Math.floor(n / i) % 10;
    if (d === 0) zero = zero || s !== '';
    else {
      if (zero) s += '零';
      zero = false;
      s += PUR_DIGITS[d] + u;
    }
  });
  return s;
}

// 金额大写（分为单位的整数）：240000 → 人民币贰仟肆佰元整（跟 purchase.py 的 rmb_upper 一样）
function rmbUpper(c) {
  if (!Number.isFinite(c) || c < 0) return '';
  const yuan = Math.floor(c / 100);
  const jiao = Math.floor(c / 10) % 10;
  const fen = c % 10;
  let out = '';
  let needZero = false;
  for (const [n, u] of [[Math.floor(yuan / 1e8) % 1e4, '亿'], [Math.floor(yuan / 1e4) % 1e4, '万'], [yuan % 1e4, '']]) {
    if (n === 0) {
      needZero = needZero || out !== '';
      continue;
    }
    if (out && (needZero || n < 1000)) out += '零';
    out += four(n) + u;
    needZero = false;
  }
  if (!jiao && !fen) return `人民币${out || '零'}元整`;
  let s = out ? `${out}元` : '';
  if (jiao) s += PUR_DIGITS[jiao] + '角';
  else if (out) s += '零';
  if (fen) s += PUR_DIGITS[fen] + '分';
  return `人民币${s}`;
}

function cnDate(iso) {
  return iso && iso.length >= 10 ? `${iso.slice(0, 4)}年${+iso.slice(5, 7)}月${+iso.slice(8, 10)}日` : '';
}

function purMsg(text, cls) {
  const el = $('pur-msg');
  el.textContent = text;
  el.className = `inv-msg ${cls || ''}`;
}

function findPurVendor(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return null;
  return (purCfg().vendors || []).find((v) => v.name.toLowerCase() === n || (v.names || []).some((x) => String(x).toLowerCase() === n)) || null;
}

async function openPurchase(key) {
  if (state.picking) return;
  try {
    const r = await fetch(`/api/purchase/draft?key=${encodeURIComponent(key)}`, { cache: 'no-store', credentials: 'same-origin' });
    const doc = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(doc.error || `HTTP ${r.status}`);
    const d = doc.doc;
    state.pur = {
      ...d,
      seller: { name: d.seller.name || '', lines: (d.seller.lines || []).join('\n') },
      ship_to: { name: d.ship_to.name || '', lines: (d.ship_to.lines || []).join('\n') },
      terms: (d.terms || []).join('\n'),
      lines: (d.lines || []).map((l) => ({ ...l, qty: String(l.qty ?? ''), price: String(l.price ?? '') })),
      savedNo: doc.saved ? d.no : '',
      loadedNo: d.no,
      sellerTouched: !!doc.saved,
    };
  } catch (e) {
    toast(`打不开采购订单：${e.message || e}`);
    return;
  }
  document.body.classList.add('purchasing');
  $('pur-view').hidden = false;
  $('pur-by').value = state.me;
  $('toast').hidden = true;
  purMsg(state.pur.savedNo ? `这个 PO 已经做过 ${state.pur.savedNo}（${cnDate(state.pur.date)}），下面是上次存的内容；改完再导出会覆盖它。` : '');
  renderPurchase();
  window.scrollTo(0, 0);
}

function closePurchase() {
  state.pur = null;
  document.body.classList.remove('purchasing');
  $('pur-view').hidden = true;
  render();
}

function partyHead(c) {
  const b = c.buyer || {};
  if (!b.name) return '<div class="pur-hd"><div class="pur-co need-text">抬头还没设（Mac 上 data/purchase.json）</div></div>';
  return `<div class="pur-hd"><div class="pur-co">${esc(b.name)}</div>${(b.lines || []).map((x) => `<div class="pur-ln">${esc(x)}</div>`).join('')}</div>`;
}

function renderPurchase() {
  const p = state.pur;
  const vendors = (purCfg().vendors || []).map((v) => `<option value="${esc(v.name)}"></option>`).join('');
  const rows = p.lines
    .map(
      (l, i) => `<tr data-i="${i}">
      <td class="c">${i + 1}</td>
      <td><input data-f="line" maxlength="12" value="${esc(l.line)}" aria-label="行号" /></td>
      <td><input data-f="pn" maxlength="40" value="${esc(l.pn)}" aria-label="物料编码" /></td>
      <td><input data-f="rev" maxlength="12" value="${esc(l.rev)}" aria-label="版本" /></td>
      <td><input data-f="desc" maxlength="200" value="${esc(l.desc)}" aria-label="产品描述" /></td>
      <td><input data-f="qty" inputmode="decimal" class="num" value="${esc(l.qty)}" aria-label="数量" /></td>
      <td><input data-f="price" inputmode="decimal" class="num" value="${esc(l.price)}" aria-label="单价（未税）" />${
        l.price_incl !== null && l.price_incl !== undefined ? `<div class="pur-hint">PO 含税 ¥${esc(num(l.price_incl))}</div>` : ''
      }</td>
      <td class="num" data-out="amt"></td>
      <td class="c"><button type="button" class="btn-link" data-act="pur-drop" title="去掉这一行">去掉</button></td>
    </tr>`,
    )
    .join('');
  $('pur-sheet').innerHTML = `${partyHead(purCfg())}
    <div class="pur-title">采 购 订 单</div>
    <table class="pur-info">
      <tr><td class="k">订单编号</td><td><input id="pur-no" maxlength="40" value="${esc(p.no)}" /></td>
          <td class="k">订单日期</td><td><input id="pur-date" type="date" value="${esc(p.date)}" /></td></tr>
      <tr><td class="k">交付日期</td><td><input id="pur-due" type="date" value="${esc(p.due)}" /></td>
          <td class="k">客户订单号</td><td><input id="pur-cpo" maxlength="80" value="${esc(p.customer_po)}" /></td></tr>
      <tr><td class="k">供方（卖方）</td>
          <td><input id="pur-sname" maxlength="80" list="pur-vendors" value="${esc(p.seller.name)}" placeholder="供方全称${p.seller_short ? `（${esc(p.seller_short)}）` : ''}" class="${p.seller.name ? '' : 'need'}" />
              <textarea id="pur-slines" rows="3" placeholder="地址、电话、税号、联系人，每行一项">${esc(p.seller.lines)}</textarea></td>
          <td class="k">收货信息</td>
          <td><input id="pur-tname" maxlength="80" value="${esc(p.ship_to.name)}" />
              <textarea id="pur-tlines" rows="3">${esc(p.ship_to.lines)}</textarea></td></tr>
    </table>
    <datalist id="pur-vendors">${vendors}</datalist>
    <div class="inv-table-wrap"><table class="pur-items">
      <thead><tr><th>序号</th><th>行号</th><th>物料编码<br>(P/N)</th><th>版本</th><th>产品描述 (Description)</th><th>数量</th><th>单价 (RMB)<br><span class="th-sub">未税</span></th><th>小计 (RMB)</th><th></th></tr></thead>
      <tbody id="pur-rows">${rows}</tbody>
      <tbody>
        <tr><td colspan="9" class="pur-add"><button type="button" class="btn-link" data-act="pur-add">＋ 加一行</button></td></tr>
        <tr class="tot"><td colspan="5" id="pur-up1"></td><td class="c" id="pur-qty"></td><td class="c">总计<br>(Total)</td><td class="num" id="pur-total"></td><td></td></tr>
        <tr class="tot"><td colspan="6" id="pur-up2"></td><td class="c nowrap">含税总计<br>(含 <input id="pur-rate" inputmode="decimal" class="num rate" value="${esc(p.tax_rate)}" aria-label="税率" />%税)</td><td class="num" id="pur-taxed"></td><td></td></tr>
      </tbody>
    </table></div>
    <p class="pur-cmp muted" id="pur-cmp"></p>
    <label class="pur-terms">订单条款与备注说明（每行一条，「标题：」打印成粗体）
      <textarea id="pur-terms" rows="6">${esc(p.terms)}</textarea></label>
    <p class="muted inv-help">单价按未税填：从 PO 带出来的是 PO 上的含税单价 ÷ (1 + 税率)，四舍五入到分，可以直接改成供方报的未税价。导出或打印时会保存；供方全称和下面几行会记下来，下次同一家自动带出。</p>`;
  purTotals();
}

function purCalc() {
  const p = state.pur;
  let total = 0;
  let qty = 0;
  let ok = true;
  const amts = p.lines.map((l) => {
    const q = purNum(l.qty);
    const pr = purNum(l.price);
    if (!Number.isFinite(q) || !Number.isFinite(pr)) {
      ok = false;
      return NaN;
    }
    const c = cents(q * pr);
    total += c;
    qty += q;
    return c;
  });
  const rate = purNum(p.tax_rate);
  const taxed = ok && Number.isFinite(rate) ? cents((total / 100) * (1 + rate / 100)) : NaN;
  return { amts, total: ok ? total : NaN, qty, taxed, rate };
}

function purTotals() {
  const p = state.pur;
  const c = purCalc();
  document.querySelectorAll('#pur-rows tr').forEach((tr) => {
    tr.querySelector('[data-out="amt"]').textContent = fmtYuan(c.amts[+tr.dataset.i]);
  });
  $('pur-up1').innerHTML = `<b>合计金额（大写）：${esc(rmbUpper(c.total))}</b>`;
  $('pur-up2').innerHTML = `<b>含税金额（大写）：${esc(rmbUpper(c.taxed))}</b>`;
  $('pur-qty').textContent = Number.isFinite(c.qty) ? String(Math.round(c.qty * 10000) / 10000) : '';
  $('pur-total').textContent = fmtYuan(c.total);
  $('pur-taxed').textContent = fmtYuan(c.taxed);
  const po = purNum(p.po_amount);
  $('pur-cmp').textContent =
    Number.isFinite(po) && Number.isFinite(c.taxed) && cents(po) !== c.taxed
      ? `对照：PO 上的金额（含税）是 ${fmtYuan(cents(po))}，这里含税总计 ${fmtYuan(c.taxed)}，差 ${fmtYuan(Math.abs(c.taxed - cents(po)))}。`
      : '';
}

function syncTerms(oldNo, newNo) {
  const p = state.pur;
  if (oldNo && newNo && oldNo !== newNo && p.terms.includes(oldNo)) {
    p.terms = p.terms.split(oldNo).join(newNo);
    $('pur-terms').value = p.terms;
  }
}

function onPurInput(e) {
  const p = state.pur;
  const t = e.target;
  const tr = t.closest('#pur-rows tr');
  if (tr && t.dataset.f) {
    p.lines[+tr.dataset.i][t.dataset.f] = t.value;
    purTotals();
    return;
  }
  const map = { 'pur-date': 'date', 'pur-due': 'due', 'pur-cpo': 'customer_po', 'pur-rate': 'tax_rate', 'pur-terms': 'terms' };
  if (t.id === 'pur-no') {
    const old = p.no;
    p.no = t.value;
    syncTerms(old.trim(), p.no.trim());
  } else if (map[t.id]) p[map[t.id]] = t.value;
  else if (t.id === 'pur-sname') {
    p.seller.name = t.value;
    t.classList.toggle('need', !t.value.trim());
    const v = findPurVendor(t.value);
    if (v && (!p.seller.lines.trim() || !p.sellerTouched)) {
      p.seller.lines = (v.lines || []).join('\n');
      $('pur-slines').value = p.seller.lines;
    }
  } else if (t.id === 'pur-slines') {
    p.seller.lines = t.value;
    p.sellerTouched = true;
  } else if (t.id === 'pur-tname') p.ship_to.name = t.value;
  else if (t.id === 'pur-tlines') p.ship_to.lines = t.value;
  if (t.id === 'pur-rate') purTotals();
}

function onPurClick(e) {
  const p = state.pur;
  const act = e.target.closest('[data-act]');
  if (!act) return;
  if (act.dataset.act === 'pur-drop') {
    if (p.lines.length <= 1) {
      purMsg('至少要留一行', 'bad');
      return;
    }
    p.lines.splice(+act.closest('tr').dataset.i, 1);
    renderPurchase();
  } else if (act.dataset.act === 'pur-add') {
    p.lines.push({ line: '', pn: '', rev: '', desc: '', qty: '', price: '', price_incl: null });
    renderPurchase();
    const inputs = document.querySelectorAll('#pur-rows tr:last-child input');
    if (inputs.length) inputs[0].focus();
  }
}

function purProblems() {
  const p = state.pur;
  const out = [];
  if (!p.no.trim()) out.push('订单编号没填');
  if (!p.date) out.push('订单日期没填');
  if (!p.seller.name.trim()) out.push('供方名称没填');
  p.lines.forEach((l, i) => {
    if (!l.pn.trim() && !l.desc.trim()) out.push(`第 ${i + 1} 行没填物料编码`);
    if (!Number.isFinite(purNum(l.qty))) out.push(`第 ${i + 1} 行数量不对`);
    if (!Number.isFinite(purNum(l.price))) out.push(`第 ${i + 1} 行单价不对`);
  });
  if (!Number.isFinite(purNum(p.tax_rate))) out.push('税率不对');
  return out;
}

const splitLines = (s) => String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);

async function savePurchase() {
  const p = state.pur;
  const by = $('pur-by').value.trim();
  if (!by) {
    $('pur-by').focus();
    purMsg('先填你的名字（记在跟进记录里）', 'bad');
    return null;
  }
  state.me = by;
  store(NAME_KEY, by);
  const bad = purProblems();
  if (bad.length) {
    purMsg(bad.slice(0, 4).join('；') + (bad.length > 4 ? ' …' : ''), 'bad');
    return null;
  }
  const no = p.no.trim();
  const old = (purCfg().list || []).find((x) => x.no === no);
  if (old && old.key !== p.key && !confirm(`订单编号 ${no} 已经用在 ${old.po} 上了（${cnDate(old.date)}）。用这一张覆盖它吗？`)) return null;
  purMsg('正在保存…');
  const doc = await postJSON('/api/purchase/save', {
    by,
    purchase: {
      key: p.key, no, date: p.date, due: p.due, customer_po: p.customer_po.trim(), tax_rate: String(p.tax_rate).trim(),
      seller: { name: p.seller.name.trim(), lines: splitLines(p.seller.lines) },
      ship_to: { name: p.ship_to.name.trim(), lines: splitLines(p.ship_to.lines) },
      lines: p.lines.map((l) => ({ line: l.line.trim(), pn: l.pn.trim(), rev: l.rev.trim(), desc: l.desc.trim(), qty: String(l.qty).trim(), price: String(l.price).trim() })),
      terms: splitLines(p.terms),
    },
  });
  p.savedNo = no;
  purMsg(`已保存 ${no}：含税总计 ${fmtYuan(cents(doc.purchase.taxed))}`, 'good');
  load();
  return doc.purchase;
}

function downloadPurchase(d) {
  const a = document.createElement('a');
  a.href = `/api/purchase/xlsx?no=${encodeURIComponent(d.no)}`;
  a.download = `采购订单-${d.no}${d.seller_short ? `-${d.seller_short}` : ''}.xlsx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function exportPurXlsx() {
  try {
    const d = await savePurchase();
    if (d) downloadPurchase(d);
  } catch (e) {
    purMsg(`没保存：${e.message || e}`, 'bad');
  }
}

async function printPurchase() {
  try {
    const d = await savePurchase();
    if (!d) return;
    $('inv-print').innerHTML = purPrintHtml(d);
    if (document.fonts) {
      // 等线字体文件大（Mac 上 data/fonts/ 有才有），等它下完再打印，不然 PDF 里会是别的字体
      purMsg('正在准备打印（第一次要下载等线字体，稍等）…');
      await Promise.all(['400', '700'].map((w) => document.fonts.load(`${w} 12px "PO DengXian"`, '采购订单'))).catch(() => {});
      purMsg(`已保存 ${d.no}`, 'good');
    }
    const title = document.title;
    document.title = `采购订单-${d.no}${d.seller_short ? `-${d.seller_short}` : ''}`; // 存 PDF 时默认文件名
    window.print();
    setTimeout(() => (document.title = title), 500);
  } catch (e) {
    purMsg(`没保存：${e.message || e}`, 'bad');
  }
}

function partyHtml(party) {
  return `<b>${esc(party.name)}</b>${(party.lines || []).map((x) => `<br>${esc(x)}`).join('')}`;
}

function termHtml(t) {
  const m = /^(.{1,20}?[：:])(.*)$/.exec(t);
  return m ? `<li><b>${esc(m[1])}</b>${esc(m[2])}</li>` : `<li>${esc(t)}</li>`;
}

// 打印用的静态版本（跟样张一个样子），用服务器算好的数
function purPrintHtml(d) {
  const y = (x) => fmtYuan(cents(x));
  const rows = d.lines
    .map(
      (l, i) => `<tr><td class="r">${i + 1}</td><td class="r">${esc(l.line)}</td><td class="r">${esc(l.pn)}</td><td class="r">${esc(l.rev)}</td><td class="r d">${esc(l.desc)}</td><td class="r">${esc(l.qty)}</td><td class="r n">${y(l.price)}</td><td class="r n">${y(l.amount)}</td></tr>`,
    )
    .join('');
  return `<div class="pur-doc">${partyHead(purCfg())}
    <div class="pur-title">采购订单</div>
    <table class="pi">
      <tr><td class="k">订单编号</td><td class="v">${esc(d.no)}</td><td class="k">订单日期</td><td class="v">${esc(cnDate(d.date))}</td></tr>
      <tr><td class="k">交付日期</td><td class="v">${esc(cnDate(d.due))}</td><td class="k">客户订单号</td><td class="v">${esc(d.customer_po)}</td></tr>
      <tr><td class="k">供方（卖方）</td><td class="v">${partyHtml(d.seller)}</td><td class="k">收货信息</td><td class="v">${partyHtml(d.ship_to)}</td></tr>
    </table>
    <table class="pt">
      <colgroup><col style="width:6%"><col style="width:6%"><col style="width:12%"><col style="width:6%"><col><col style="width:6%"><col style="width:11%"><col style="width:11%"></colgroup>
      <tr><th>序号</th><th>行号</th><th>物料编码<br>(P/N)</th><th>版本</th><th>产品描述 (Description)</th><th>数量</th><th>单价 (RMB)</th><th>小计 (RMB)</th></tr>
      ${rows}
      <tr class="t1"><td class="cap" colspan="5">合计金额（大写）：${esc(d.total_upper)}</td><td>${esc(d.qty_total)}</td><td class="lb">总计<br>(Total)</td><td class="amt">${y(d.total)}</td></tr>
      <tr class="t2"><td class="cap" colspan="6">含税金额（大写）：${esc(d.taxed_upper)}</td><td class="lb">含税总计<br>(含${esc(d.tax_rate)}%税)</td><td class="amt">${y(d.taxed)}</td></tr>
    </table>
    ${(d.terms || []).length ? `<div class="pterms"><div class="h">订单条款与备注说明：</div><ol>${d.terms.map(termHtml).join('')}</ol></div>` : ''}
  </div>`;
}

function initPurchase() {
  $('pur-back').addEventListener('click', closePurchase);
  $('pur-xlsx').addEventListener('click', exportPurXlsx);
  $('pur-print-btn').addEventListener('click', printPurchase);
  const sheet = $('pur-sheet');
  sheet.addEventListener('input', onPurInput);
  sheet.addEventListener('click', onPurClick);
  $('rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pur]');
    if (b) openPurchase(b.dataset.pur);
  });
}

initPurchase();
