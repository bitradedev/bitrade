/* Manual trading uses the same real-quote paper matcher as Agent orders. */
'use strict';
const $ = (s) => document.querySelector(s),
  en = BiUI.language === 'en';
const t = (zh, english) => (en ? english : zh);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
const money = (v) =>
  v === null || v === undefined || !Number.isFinite(Number(v))
    ? '—'
    : Number(v).toLocaleString(BiUI.locale, {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 2,
      });
const price = (v) =>
  v === null || v === undefined || !(v > 0)
    ? '—'
    : '$' + Number(v).toLocaleString(BiUI.locale, { maximumSignificantDigits: 6 });
const qty = (v, d = 18) =>
  v === undefined || v === null
    ? '—'
    : (Number(BigInt(v)) / 10 ** d).toLocaleString(BiUI.locale, { maximumSignificantDigits: 7 });
const short = (v) => (v ? v.slice(0, 6) + '…' + v.slice(-4) : '—');
const time = (v) =>
  v
    ? new Date(v).toLocaleTimeString(BiUI.locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })
    : '—';
const date = (v) =>
  new Date(v).toLocaleString(BiUI.locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
const status = (v) =>
  ({
    preparing: t('准备中', 'Preparing'),
    queued: t('等待撮合', 'Pending'),
    quoting: t('核对成交价', 'Pricing'),
    filled: t('已成交', 'Filled'),
    partial: t('部分成交', 'Partially filled'),
    failed: t('未成交', 'Not filled'),
    cancelled: t('已取消', 'Cancelled'),
  })[v] ?? t('待确认', 'Pending');
let terminalChart = null;
let csrf = null,
  owner = false,
  book = { account: null, positions: [], orders: [], fills: [] },
  markets = [],
  chosen = null,
  points = [],
  query = '',
  side = 'buy',
  amount = '',
  unit = 'USD',
  percent = 100,
  tab = 'positions',
  busy = false,
  error = '',
  quote = null,
  requestKey = null,
  selection = 0,
  polling = false,
  lookupPending = 0,
  lastLookup = 0,
  retryAfter = 0;
const knownErrors = {
  '虚拟余额不足，请为费用预留余额': 'Insufficient virtual balance. Leave room for fees.',
  虚拟余额不足以支付卖出费用: 'Insufficient virtual balance for exit fees.',
  请输入有效的买入金额: 'Enter a valid buy amount.',
  买入金额必须大于零: 'The amount must be greater than zero.',
  卖出数量超过模拟持仓: 'The sell amount exceeds your paper position.',
  '当前无法确认模拟成交报价，请稍后重试':
    'A current trade quote is unavailable. Please try again later.',
  该代币当前没有可用的模拟报价: 'No current paper quote is available for this token.',
  '报价已过期，请重新报价': 'The quote expired. Request a new quote.',
  '报价不存在，请重新报价': 'This quote is unavailable. Request a new quote.',
  '该报价已经提交，请重新报价': 'This quote was already submitted. Check your orders.',
  '订单尚未完成或报价发生变化，请查看订单后重新报价':
    'Check your pending order, then request a new quote.',
  '本次模拟订单未完成，请查看订单后重试':
    'The order was not completed. Check your orders before retrying.',
  '请求过于频繁，请稍后重试': 'Too many requests. Please wait before trying again.',
  请先开启手动模拟账户: 'Start your paper account first.',
  钱包地址无效: 'Enter a valid token contract address.',
  金额须为正整数字符串: 'Choose a non-zero amount.',
  订单不存在: 'Order not found.',
  该订单已不能取消: 'This order can no longer be cancelled.',
  账户请求校验失败: 'Refresh the page to continue with this account.',
  请先连接账户: 'Start a browser account to continue.',
};
function message(e) {
  return knownErrors[e.message]
    ? en
      ? knownErrors[e.message]
      : e.message
    : t(
        '暂时无法完成，请稍后重试。账户记录会保留。',
        'Unable to complete this request. Try again later; your records are retained.',
      );
}
async function api(path, data) {
  const r = await fetch(path, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers:
      data === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal: AbortSignal.timeout(35000),
  });
  let v;
  try {
    v = await r.json();
  } catch {
    v = {};
  }
  if (!r.ok) {
    const seconds = Number(r.headers.get('Retry-After'));
    if (r.status === 429 || r.status === 503)
      retryAfter = Math.max(
        retryAfter,
        Date.now() + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 15000),
      );
    const e = Error(v.error ?? 'Unavailable');
    e.status = r.status;
    throw e;
  }
  return v;
}
function notify(text) {
  const node = $('#trade-toast');
  node.textContent = text;
  node.classList.add('visible');
  setTimeout(() => node.classList.remove('visible'), 4500);
}
function tokenName(token) {
  return (
    markets.find((m) => m.token === token)?.symbol ??
    (chosen?.token === token ? chosen.symbol : short(token))
  );
}
function currentPosition() {
  return book.positions.find((p) => p.token === chosen?.token);
}
function tokenAvatar(m) {
  let logo = null;
  try {
    const url = new URL(m.logo);
    if (url.protocol === 'https:' && !url.username && !url.password) logo = url.href;
  } catch {}
  const letter = String(m.symbol ?? '').startsWith('0x')
    ? '◇'
    : (Array.from(String(m.symbol ?? ''))[0]?.toUpperCase() ?? '◇');
  return `<span class="token-avatar" aria-hidden="true"><span>${esc(letter)}</span>${logo ? `<img data-token-logo src="${esc(logo)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</span>`;
}
function table() {
  if (!book.account)
    return `<div class="trade-empty">${t('开启模拟账户后，持仓和成交会记录在这里。', 'Start a paper account to keep your positions and fills here.')}</div>`;
  if (tab === 'positions')
    return book.positions.length
      ? `<div class="trade-table"><table><thead><tr>${[t('代币', 'Token'), t('数量 / 估值', 'Amount / value'), t('成本 / 浮动盈亏', 'Cost / unrealized P&L'), t('操作', 'Action')].map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${book.positions.map((p) => `<tr><td><button class="trade-link" data-act="position" data-token="${esc(p.token)}">${esc(p.symbol)}</button><small>${esc(short(p.token))}</small></td><td>${qty(p.remainingRaw, p.decimals)}<small>${money(p.estimatedValueUsd)}</small></td><td>${money(p.costUsd)}<small class="${p.estimatedValueUsd === null ? '' : p.estimatedValueUsd - p.costUsd >= 0 ? 'positive' : 'negative'}">${p.estimatedValueUsd === null ? '—' : money(p.estimatedValueUsd - p.costUsd)}</small></td><td><button data-act="position" data-token="${esc(p.token)}">${t('卖出', 'Sell')}</button></td></tr>`).join('')}</tbody></table></div>`
      : `<div class="trade-empty">${t('还没有持仓。选择代币，试试第一笔模拟买入。', 'No positions yet. Select a token for your first paper buy.')}</div>`;
  if (tab === 'fills')
    return book.fills.length
      ? `<div class="trade-table"><table><thead><tr>${[t('时间', 'Time'), t('代币 / 操作', 'Token / side'), t('金额（含费用）', 'Amount after fees'), t('已实现盈亏', 'Realized P&L')].map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${book.fills.map((f) => `<tr><td>${date(f.at)}<small>${t('模拟成交', 'Paper fill')}</small></td><td>${esc(tokenName(f.token))}<small class="${f.side === 'buy' ? 'positive' : 'negative'}">${f.side === 'buy' ? t('买入', 'Buy') : t('卖出', 'Sell')}</small></td><td>${money(f.usd)}<small>${qty(f.nativeRaw)} ETH</small></td><td class="${f.netUsd === null ? '' : f.netUsd >= 0 ? 'positive' : 'negative'}">${money(f.netUsd)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="trade-empty">${t('还没有成交。提交订单后，需要在后续区块完成撮合。', 'No fills yet. Orders match against a later block after submission.')}</div>`;
  return book.orders.length
    ? `<div class="trade-table"><table><thead><tr>${[t('提交时间', 'Submitted'), t('代币 / 操作', 'Token / side'), t('状态', 'Status'), t('操作', 'Action')].map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${book.orders.map((o) => `<tr><td>${date(o.createdAt)}</td><td>${esc(tokenName(o.token))}<small>${o.side === 'buy' ? t('买入', 'Buy') : t('卖出', 'Sell')}</small></td><td>${status(o.status)}${o.failed ? `<small>${t('未扣除买入本金，请重新报价。', 'No buy capital was spent. Request a new quote.')}</small>` : ''}</td><td>${o.canCancel ? `<button data-act="cancel" data-id="${esc(o.id)}">${t('取消', 'Cancel')}</button>` : '—'}</td></tr>`).join('')}</tbody></table></div>`
    : `<div class="trade-empty">${t('还没有手动订单。', 'No manual orders yet.')}</div>`;
}
function marketRows() {
  const q = query.trim().toLowerCase(),
    rows = markets.filter(
      (m) =>
        !q ||
        [m.symbol, m.name, m.token].some((v) =>
          String(v ?? '')
            .toLowerCase()
            .includes(q),
        ),
    );
  return rows.length
    ? rows
        .map(
          (m) =>
            `<button class="market-row" data-act="choose" data-token="${esc(m.token)}" aria-pressed="${chosen?.token === m.token}"><span class="market-token">${tokenAvatar(m)}<span><strong>${esc(m.symbol)}</strong><small>${m.stage === 'dex' ? t('已毕业', 'Graduated') : m.stage === 'curve' ? t('曲线交易', 'Bonding curve') : 'Pons V2'}</small></span></span><span><b>${price(m.priceUsd)}</b><small>${m.at ? time(m.at) : '—'}</small></span></button>`,
        )
        .join('')
    : `<div class="trade-empty">${t('未找到？粘贴完整合约地址查询。', 'Not listed? Paste the full contract address.')}</div>`;
}
function render() {
  const focused = document.activeElement?.id,
    caret = document.activeElement?.selectionStart,
    scroll = $('#market-list')?.scrollTop ?? 0;
  const pos = currentPosition(),
    a = book.account;
  const content = `<div class="trade-title"><div><div class="trade-kicker">YOUR CALL. VIRTUAL CAPITAL.</div><h1>${t('手动模拟交易', 'Paper trading')}</h1><p>${t('真实行情，虚拟资金。每一笔由你决定。', 'Real quotes. Virtual funds. Every trade is your call.')}</p></div><span class="trade-badge">Robinhood Chain · Pons V2</span></div>${error ? `<div class="trade-error-banner" role="alert">${esc(error)}</div>` : ''}<div class="trade-layout"><aside class="trade-panel trade-watchlist"><div class="trade-panel-head"><h2>${t('发现代币', 'Discover tokens')}</h2><span class="trade-caption">${markets.length}</span></div><form class="trade-search" id="token-search"><label for="token-query">${t('名称或合约地址', 'Name or contract address')}</label><input id="token-query" placeholder="${t('搜索代币 / 粘贴 CA', 'Search tokens / paste CA')}" value="${esc(query)}" ${busy ? 'disabled' : ''} autocomplete="off" spellcheck="false"><button class="button secondary" ${busy ? 'disabled' : ''} type="submit">${t('查询合约', 'Look up contract')}</button></form><div class="market-list" id="market-list">${marketRows()}</div><p class="market-list-note">${t('最近收录的 Pons V2 代币。列表价格保留实际采样时间；下单前重新报价。', 'Recently indexed Pons V2 tokens. Listed prices keep their observation time; trades use a new quote.')}</p></aside><div class="trade-middle"><section class="trade-panel trade-price-panel">${chosen ? `<div class="token-head"><div class="token-identity">${tokenAvatar(chosen)}<div><h2>${esc(chosen.symbol)}</h2><a href="https://robinhoodchain.blockscout.com/token/${esc(chosen.token)}" target="_blank" rel="noopener noreferrer">${esc(short(chosen.token))} ↗</a><p class="trade-caption">${chosen.stage === 'dex' ? t('已毕业 · Uniswap V4', 'Graduated · Uniswap V4') : chosen.stage === 'curve' ? t('Pons V2 曲线交易', 'Pons V2 bonding curve') : 'Pons V2'}</p></div></div><div class="token-price"><small>${t('单币价格 · USD', 'Token price · USD')}</small><strong>${price(chosen.priceUsd)}</strong>${chosen.priceEth > 0 ? `<span class="trade-caption">${Number(chosen.priceEth).toLocaleString(BiUI.locale, { maximumSignificantDigits: 6 })} ETH</span>` : ''}<small>${t('采样时间', 'Observed at')} ${time(chosen.at)}</small><button class="trade-link" data-act="update" ${busy ? 'disabled' : ''}>${t('更新报价', 'Refresh price')}</button></div></div><div class="token-metrics"><div><small>${t('实有曲线储备', 'Actual curve reserve')}</small><b>${money(chosen.reserveUsd)}</b></div><div><small>${t('毕业进度', 'Graduation progress')}</small><b>${Number.isFinite(chosen.progressPct) ? Math.min(100, Math.max(0, chosen.progressPct)).toFixed(1) + '%' : '—'}</b></div><div><small>${t('买入 / 卖出税率', 'Buy / sell tax')}</small><b>${chosen.buyTaxPct === null || chosen.buyTaxPct === undefined ? '—' : Number(chosen.buyTaxPct).toFixed(2) + '%'} / ${chosen.sellTaxPct === null || chosen.sellTaxPct === undefined ? '—' : Number(chosen.sellTaxPct).toFixed(2) + '%'}</b></div></div><div id="chart-region" class="price-chart"></div>` : `<div class="trade-empty">${t('从左侧选择代币，或输入 Pons V2 合约地址。', 'Select a token, or paste a Pons V2 contract address.')}</div>`}</section><section class="trade-panel trade-history-panel"><div class="trade-history-tabs">${[
    ['positions', t('持仓', 'Positions')],
    ['fills', t('成交记录', 'Fills')],
    ['orders', t('订单', 'Orders')],
  ]
    .map(
      ([id, label]) =>
        `<button data-act="tab" data-id="${id}" aria-pressed="${tab === id}">${label}${id === 'orders' && a?.pending ? ' · ' + a.pending : ''}</button>`,
    )
    .join(
      '',
    )}</div>${table()}</section></div><aside class="trade-panel trade-order-panel"><div class="trade-panel-head"><h2>${t('我的手动模拟账户', 'My paper account')}</h2><span class="trade-badge">${t('模拟', 'Paper')}</span></div><div class="trade-book">${a ? `<span class="trade-caption">${t('可用虚拟余额', 'Available virtual balance')}</span><div class="account-value">${money(a.balanceUsd)} <small>${qty(a.balanceWei)} ETH</small></div><div class="account-stats"><div><small>${t('已实现盈亏', 'Realized P&L')}</small><span class="${a.realizedUsd >= 0 ? 'positive' : 'negative'}">${money(a.realizedUsd)}</span></div><div><small>${t('累计费用', 'Total fees')}</small>${money(a.feesUsd)}</div></div><div class="trade-tabs">${['buy', 'sell'].map((v) => `<button class="${v}" data-act="side" data-id="${v}" aria-pressed="${side === v}" ${busy ? 'disabled' : ''}>${v === 'buy' ? t('买入', 'Buy') : t('卖出', 'Sell')}</button>`).join('')}</div>${side === 'buy' ? `<label for="trade-amount">${t('买入金额', 'Buy amount')}</label><div class="trade-input-line"><input id="trade-amount" inputmode="decimal" placeholder="0.00" value="${esc(amount)}" ${busy ? 'disabled' : ''}><select id="trade-unit" ${busy ? 'disabled' : ''} aria-label="${t('金额单位', 'Amount currency')}"><option ${unit === 'USD' ? 'selected' : ''}>USD</option><option ${unit === 'ETH' ? 'selected' : ''}>ETH</option></select></div><div class="trade-presets">${[50, 100, 250, 500].map((v) => `<button data-act="preset" data-id="${v}" ${busy ? 'disabled' : ''}>$${v}</button>`).join('')}</div>` : `<label>${t('卖出持仓比例', 'Position to sell')}</label><div class="account-value">${percent}% <small>${pos ? qty(String((BigInt(pos.remainingRaw) * BigInt(percent)) / 100n), pos.decimals) : '0'} ${esc(chosen?.symbol ?? '')}</small></div><div class="trade-presets">${[25, 50, 75, 100].map((v) => `<button data-act="percent" data-id="${v}" aria-pressed="${percent === v}" ${busy ? 'disabled' : ''}>${v}%</button>`).join('')}</div><p class="trade-caption">${t('当前持仓', 'Your position')}：${pos ? qty(pos.remainingRaw, pos.decimals) : '0'} ${esc(chosen?.symbol ?? '')}</p>`}<button class="button trade-submit ${side}" data-act="preview" ${busy || !chosen || (side === 'sell' && !pos) || a.pending ? 'disabled' : ''}>${side === 'buy' ? t('预览模拟买入', 'Preview paper buy') : t('预览模拟卖出', 'Preview paper sell')}</button><div class="trade-details"><div><span>${t('交易代币', 'Token')}</span><b>${esc(chosen?.symbol ?? '—')}</b></div><div><span>${t('最大滑点', 'Max. slippage')}</span><b>30%</b></div><div><span>${t('成交方式', 'Execution')}</span><b>${t('后续区块重新报价', 'Repriced in a later block')}</b></div></div><p class="trade-note">${t('费用在确认前展示。滑点是允许的最大报价变化，不是固定扣费。', 'Fees are shown before confirmation. Slippage limits quote changes; it is not a fixed fee.')}</p>${a.pending ? `<p class="trade-note">${t('有待处理订单，请先查看订单。', 'You have a pending order. Check Orders before placing another.')}</p>` : ''}` : `<div class="trade-welcome"><h3>${t('用 1000U 虚拟资金，<br>试试自己的判断。', 'Test your conviction.<br>Start with $1,000 virtual.')}</h3><p>${t('无需充值、连接钱包或接入 AI。你的手动账户与 Agent 账户独立。', 'No deposits, wallet connection or AI setup. Your manual account is separate from your Agents.')}</p><button class="button" data-act="start" ${busy ? 'disabled' : ''}>${t('开启手动模拟', 'Start paper trading')}</button></div>`}<p class="trade-note">${t('账户保留在当前浏览器会话中。清除 Cookie 或退出会话后，暂不支持找回。', 'Saved to your current browser session. Clearing cookies or ending the session removes access.')}</p></div></aside></div><p class="trade-secondary-note">${t('这里只使用虚拟资金，不发送真实交易。估值不等于实际卖出净额；风险资料未知不代表安全。', 'Virtual funds only. No real transactions are sent. Reference values are not net exit proceeds; unknown risk is not a safety guarantee.')}</p>`;
  const root = $('#trade-main');
  if ($('#chart-region')) {
    const template = document.createElement('template');
    template.innerHTML = content;
    for (const selector of [
      '.token-head',
      '.token-metrics',
      '.trade-watchlist',
      '.trade-history-panel',
      '.trade-order-panel',
    ]) {
      const old = root.querySelector(selector),
        next = template.content.querySelector(selector);
      if (old && next) old.innerHTML = next.innerHTML;
    }
    root.querySelector('.trade-error-banner')?.remove();
    const banner = template.content.querySelector('.trade-error-banner');
    if (banner) root.prepend(banner);
  } else root.innerHTML = content;
  if (globalThis.BiTradeChart && document.getElementById('chart-region')) {
    terminalChart ??= new BiTradeChart(document.getElementById('chart-region'));
    terminalChart.setToken(chosen?.token ?? null);
    terminalChart.setFills(book.fills);
  }
  if (focused) {
    const node = document.getElementById(focused);
    node?.focus({ preventScroll: true });
    if (typeof caret === 'number' && node?.setSelectionRange) node.setSelectionRange(caret, caret);
  }
  if ($('#market-list')) $('#market-list').scrollTop = scroll;
}
async function choose(token) {
  const version = ++selection;
  chosen = markets.find((m) => m.token === token) ?? {
    token,
    symbol: short(token),
    priceUsd: null,
    at: null,
  };
  points = [];
  quote = null;
  error = '';
  render();
  if (!owner) return;
  await lookupChosen(version);
}
async function lookupChosen(version, quiet = false) {
  const token = chosen?.token;
  if (!owner || !token) return;
  lastLookup = Date.now();
  lookupPending++;
  try {
    const v = await api('/api/manual/lookup', { token });
    if (version !== selection) return;
    chosen = v.market;
    points = v.points;
    if (!markets.some((m) => m.token === token)) markets.unshift(chosen);
    else markets = markets.map((m) => (m.token === token ? chosen : m));
    render();
  } catch (e) {
    if (version !== selection) return;
    if (!quiet) error = message(e);
    render();
  } finally {
    lookupPending--;
  }
}
function confirm() {
  const q = quote,
    output =
      q.side === 'buy'
        ? qty(q.outputRaw, q.tokenDecimals) + ' ' + esc(chosen.symbol)
        : money(q.outputUsd - q.outsideFeesUsd);
  $('#confirm-content').innerHTML =
    `<h2 id="confirm-title">${q.side === 'buy' ? t('确认模拟买入', 'Confirm paper buy') : t('确认模拟卖出', 'Confirm paper sell')}</h2><p class="trade-caption">${esc(chosen.symbol)} · ${esc(short(chosen.token))}</p><div class="trade-confirm-data"><div><span>${t('预计支付', 'Estimated payment')}</span><b>${q.side === 'buy' ? money(q.inputUsd + q.outsideFeesUsd) : qty(q.amount, q.tokenDecimals) + ' ' + esc(chosen.symbol)}</b></div><div><span>${t('预计收到', 'Estimated receipt')}</span><b>${output}</b></div><div><span>${t('估算 Gas / 授权费用', 'Estimated gas / approval')}</span><b>${money(q.outsideFeesUsd)}</b></div><div><span>${t('已含协议费 / 税费', 'Included protocol fee / tax')}</span><b>${money(q.fees.protocolUsd + q.fees.taxUsd + q.fees.conversionUsd)}</b></div><div><span>${t('报价影响', 'Price impact')}</span><b>${Number.isFinite(q.priceImpactPct) ? q.priceImpactPct.toFixed(2) + '%' : '—'}</b></div><div><span>${t('最大滑点', 'Max. slippage')}</span><b>30%</b></div></div><p class="trade-caption">${t('这是当前报价预览，最终按后续区块的真实报价模拟成交。报价变化超过滑点上限时不成交。', 'This is a current quote preview. The paper fill uses a later real block. Orders do not fill beyond the slippage limit.')}</p><p id="confirm-error" class="trade-note error" role="alert"></p><div class="trade-confirm-actions"><button class="button secondary" data-act="dismiss">${t('返回', 'Back')}</button><button class="button" data-act="confirm">${t('确认模拟交易', 'Confirm paper trade')}</button></div>`;
  $('#trade-confirm').showModal();
}
async function updateBook() {
  if (owner) book = await api('/api/manual');
}
document.addEventListener('input', (e) => {
  if (e.target.id === 'token-query') {
    query = e.target.value;
    $('#market-list').innerHTML = marketRows();
  }
  if (e.target.id === 'trade-amount') {
    amount = e.target.value;
    quote = null;
    requestKey = null;
  }
});
document.addEventListener(
  'error',
  (e) => {
    if (e.target?.matches?.('img[data-token-logo]')) e.target.remove();
  },
  true,
);
document.addEventListener('change', (e) => {
  if (e.target.id === 'trade-unit') {
    unit = e.target.value;
    amount = '';
    quote = null;
    requestKey = null;
    render();
  }
});
document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'token-search') return;
  e.preventDefault();
  if (busy) return;
  const token = query.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) {
    error = t(
      '请选择列表中的代币，或粘贴完整合约地址。',
      'Select a listed token or paste a full contract address.',
    );
    render();
    return;
  }
  await choose(token.toLowerCase());
});
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  if (act === 'dismiss') {
    if (!busy) $('#trade-confirm').close();
    return;
  }
  if (busy) return;
  if (act === 'side') {
    side = el.dataset.id;
    quote = null;
    requestKey = null;
    render();
    return;
  }
  if (act === 'preset') {
    unit = 'USD';
    amount = el.dataset.id;
    quote = null;
    render();
    return;
  }
  if (act === 'percent') {
    percent = Number(el.dataset.id);
    quote = null;
    render();
    return;
  }
  if (act === 'tab') {
    tab = el.dataset.id;
    render();
    return;
  }
  if (act === 'choose' || act === 'position') {
    if (act === 'position') side = 'sell';
    await choose(el.dataset.token);
    return;
  }
  if (act === 'update') {
    if (chosen) await choose(chosen.token);
    return;
  }
  busy = true;
  error = '';
  render();
  try {
    if (act === 'start') {
      const s = await api('/api/session', {});
      csrf = s.csrf;
      owner = !!s.owner;
      book = await api('/api/manual/start', {});
      if (chosen) await choose(chosen.token);
    }
    if (act === 'preview') {
      const draft = {
        token: chosen.token,
        side,
        ...(side === 'buy' ? { amount, unit } : { percent }),
      };
      quote = await api('/api/manual/preview', draft);
      requestKey = 'manual-' + crypto.randomUUID();
      confirm();
    }
    if (act === 'confirm') {
      const button = $('[data-act="confirm"]');
      button.disabled = true;
      // Preserve this key on a transport failure. Retrying cannot place a second order.
      const o = await api('/api/manual/order', { previewId: quote.id, requestKey });
      $('#trade-confirm').close();
      quote = null;
      tab = 'orders';
      await updateBook();
      notify(
        o.status === 'failed'
          ? t('本次未成交，请查看订单。', 'This order did not fill. Check Orders.')
          : t(
              '模拟订单已提交，可在订单中查看结果。',
              'Paper order submitted. Check Orders for the result.',
            ),
      );
    }
    if (act === 'cancel') {
      await api('/api/manual/cancel', { id: el.dataset.id });
      await updateBook();
      notify(t('未完成的模拟订单已取消。', 'The pending paper order was cancelled.'));
    }
  } catch (e) {
    if (act === 'confirm' && $('#trade-confirm').open) {
      $('#confirm-error').textContent = message(e);
      $('[data-act="confirm"]').disabled = false;
    } else error = message(e);
  } finally {
    busy = false;
    render();
  }
});
$('#trade-confirm').addEventListener('cancel', (e) => {
  if (busy) e.preventDefault();
});
async function boot() {
  document.querySelectorAll('[data-copy]').forEach((el) => {
    el.textContent = {
      home: t('首页', 'Overview'),
      trade: t('手动模拟', 'Paper trading'),
      agents: t('我的 Agent', 'My Agents'),
      docs: t('文档', 'Docs'),
    }[el.dataset.copy];
  });
  document.title = t('手动模拟交易 · BI Trade', 'Paper trading · BI Trade');
  render();
  try {
    const [s, m] = await Promise.all([api('/api/state'), api('/api/manual/markets')]);
    owner = !!s.owner;
    csrf = s.csrf;
    markets = m.markets;
    if (owner) {
      const renewed = await api('/api/session', {});
      csrf = renewed.csrf;
      await updateBook();
    }
    render();
    const token = new URLSearchParams(location.search).get('token');
    if (token && /^0x[0-9a-fA-F]{40}$/.test(token)) await choose(token.toLowerCase());
    else if (markets[0]) await choose(markets[0].token);
  } catch (e) {
    error = message(e);
    render();
  }
}
setInterval(async () => {
  if (document.hidden || polling || busy || Date.now() < retryAfter) return;
  polling = true;
  try {
    await updateBook();
    const v = await api('/api/manual/markets');
    markets = v.markets;
    if (chosen?.at && !markets.some((m) => m.token === chosen.token)) markets.unshift(chosen);
    if (chosen) {
      const next = markets.find((m) => m.token === chosen.token);
      if (next && next.at > chosen.at) {
        chosen = next;
        points = [...points, { at: next.at, priceUsd: next.priceUsd }].slice(-120);
      }
      if (owner && !lookupPending && Date.now() - lastLookup >= 20000)
        await lookupChosen(selection, true);
    }
    render();
  } catch (e) {
    error = message(e);
    render();
  } finally {
    polling = false;
  }
}, 6000);
void boot();
