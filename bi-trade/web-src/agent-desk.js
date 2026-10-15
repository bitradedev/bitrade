import { mountTrendStudio } from './agent-studio/blue-agent.js';

export function mountAgentDesk(container, options) {
  const { t, money, date, agentName, strategyName, systemMessage, onProfile, loadActivity } =
    options;
  let agents = [],
    activity = [],
    activeId = null,
    room = null,
    disposed = false,
    paused = false;
  let tabsSignature = '',
    detailVersion = 0;
  const details = new Map();
  const create = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  container.classList.add('agent-desk');
  container.innerHTML = `<aside class="desk-sidebar"><div class="desk-sidebar-heading"></div><div class="desk-tabs" role="tablist"></div><div class="desk-journal"><div class="desk-journal-heading"><h3></h3><span></span></div><div class="desk-records" aria-live="polite"></div><button type="button" class="text-link desk-details"></button></div></aside><div class="desk-main"><div class="desk-heading"><span class="eyebrow"></span><h3></h3><p></p></div><div class="desk-scene"><div class="fallback"><img alt=""></div></div><div class="desk-metrics"></div><div class="desk-decision"><div class="desk-decision-heading"><strong></strong><time></time></div><p class="desk-decision-reason"></p><details class="desk-attempt"><summary></summary><p></p></details></div></div>`;
  const $ = (selector) => container.querySelector(selector);
  $('.desk-sidebar-heading').textContent = t('平台 Agent');
  $('.desk-tabs').setAttribute('aria-label', t('选择交易 Agent'));
  $('.desk-journal-heading h3').textContent = t('最近成交');
  $('.desk-journal-heading span').textContent = t('模拟');
  $('.desk-details').textContent = t('策略与完整记录 ↗');
  $('.desk-details').addEventListener('click', () => activeId && onProfile(activeId));
  const short = (value) => (value ? value.slice(0, 6) + '…' + value.slice(-4) : '—');
  function records(agent) {
    const rows = [
      ...(details.get(agent.id)?.activity ?? []),
      ...activity.filter((x) => x.agentId === agent.id),
    ];
    const unique = [
      ...new Map(rows.map((x) => [x.id ?? `${x.at}:${x.side}:${x.token}`, x])).values(),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 5);
    const target = $('.desk-records');
    const signature = JSON.stringify(unique);
    if (target.dataset.signature === signature) return;
    target.dataset.signature = signature;
    target.replaceChildren();
    if (!unique.length) {
      const empty = create('div', 'desk-record-empty');
      empty.append(
        create('span', '', '○'),
        create('strong', '', t('还没有成交')),
        create('p', '', t('通过评估与核价后，模拟成交会记录在这里。')),
      );
      target.append(empty);
      return;
    }
    for (const row of unique) {
      const item = create('div', 'desk-record');
      const time = create(
        'time',
        '',
        new Date(row.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
      );
      time.dateTime = new Date(row.at).toISOString();
      time.title = date(row.at);
      const content = create('div', 'desk-record-main');
      const action = create('strong', '', t(row.side === 'buy' ? '模拟买入' : '模拟卖出'));
      const token = create('a', 'desk-token', row.symbol || short(row.token));
      token.href = 'https://bscscan.com/token/' + row.token;
      token.target = '_blank';
      token.rel = 'noopener noreferrer';
      content.append(action, token);
      const amount = create(
        'span',
        'desk-record-amount',
        Number.isFinite(row.usd) ? money(row.usd) : '—',
      );
      item.append(time, content, amount);
      target.append(item);
    }
  }
  function renderData() {
    const agent = agents.find((x) => x.id === activeId);
    if (!agent) return;
    const index = ['trend', 'rebound', 'rotation'].indexOf(agent.avatar);
    container.dataset.agent = agent.avatar;
    for (const tab of $('.desk-tabs').children) {
      const selected = tab.dataset.agentId === agent.id;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
    }
    $('.desk-heading .eyebrow').textContent =
      `0${index + 1} / ${['TREND', 'REBOUND', 'ROTATION'][index] ?? 'AGENT'}`;
    $('.desk-heading h3').textContent = agentName(agent);
    $('.desk-heading p').textContent = strategyName(agent);
    $('.fallback img').src = `/agent-${agent.avatar}-v1.png`;
    $('.fallback img').alt = agentName(agent);
    const metrics = [
      ['虚拟可用余额', money(agent.balanceUsd)],
      ['已实现盈亏', money(agent.realizedUsd)],
      [
        '已实现收益率',
        (agent.returnPct >= 0 ? '+' : '') + Number(agent.returnPct ?? 0).toFixed(2) + '%',
      ],
      ['当前持仓', String(agent.positions ?? 0)],
    ];
    $('.desk-metrics').replaceChildren(
      ...metrics.map(([label, value], i) => {
        const item = create('div');
        item.append(create('span', '', t(label)), create('strong', '', value));
        if (i === 1 || i === 2)
          item.className =
            agent.realizedUsd < 0 ? 'negative' : agent.realizedUsd > 0 ? 'positive' : '';
        return item;
      }),
    );
    const runtime = agent.runtime;
    $('.desk-decision-heading strong').textContent = t('上次有效评估');
    $('.desk-decision-heading time').textContent = runtime?.lastDecisionAt
      ? date(runtime.lastDecisionAt)
      : t('尚无有效评估');
    $('.desk-decision-reason').textContent = systemMessage(
      runtime?.decision?.reason || t('正在等待真实行情与有效评估，尚未发起交易。'),
    );
    const attempt = runtime?.lastExecution,
      oldFailure = attempt && ['failed', 'cancelled'].includes(attempt.status);
    $('.desk-attempt').hidden = !oldFailure;
    if (oldFailure) {
      $('.desk-attempt summary').textContent = t('最近一次未成交尝试') + ' · ' + date(attempt.at);
      $('.desk-attempt p').textContent = systemMessage(attempt.reason);
    }
    records(agent);
  }
  async function refreshRecords(agent) {
    const cached = details.get(agent.id);
    if (cached && Date.now() - cached.at < 30000) return;
    const version = ++detailVersion;
    try {
      const result = await loadActivity(agent.id);
      if (disposed || version !== detailVersion) return;
      details.set(agent.id, { at: Date.now(), activity: result.activity ?? [] });
      if (activeId === agent.id) records(agent);
    } catch {
      /* Keep the last confirmed records when a refresh is delayed. */
    }
  }
  function select(id) {
    const agent = agents.find((x) => x.id === id);
    if (!agent) return;
    const changed = activeId !== id;
    activeId = id;
    try {
      sessionStorage.setItem('bi-desk-avatar', agent.avatar);
    } catch {}
    renderData();
    if (changed) {
      room?.dispose();
      room = null;
      const fallback = $('.fallback');
      fallback.hidden = false;
      fallback.style.display = 'grid';
      try {
        room = mountTrendStudio($('.desk-scene'), {
          variant: Math.max(0, ['trend', 'rebound', 'rotation'].indexOf(agent.avatar)),
          interactive: false,
          compact: innerWidth < 900,
        });
        $('.desk-scene canvas')?.setAttribute('aria-label', agentName(agent));
        room.setPaused(paused);
        room.setTheme?.(document.documentElement.dataset.theme ?? 'light');
      } catch {
        fallback.hidden = false;
        fallback.style.display = 'grid';
      }
    }
    void refreshRecords(agent);
  }
  const themeObserver = new MutationObserver(() =>
    room?.setTheme?.(document.documentElement.dataset.theme ?? 'light'),
  );
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  return {
    update(nextAgents, nextActivity = []) {
      if (disposed) return;
      agents = [...nextAgents].sort(
        (a, b) =>
          ['trend', 'rebound', 'rotation'].indexOf(a.avatar) -
          ['trend', 'rebound', 'rotation'].indexOf(b.avatar),
      );
      activity = nextActivity;
      const signature = agents.map((a) => a.id).join(',');
      if (signature !== tabsSignature) {
        tabsSignature = signature;
        $('.desk-tabs').replaceChildren();
        agents.forEach((agent, index) => {
          const tab = create('button', 'desk-tab');
          tab.type = 'button';
          tab.role = 'tab';
          tab.dataset.agentId = agent.id;
          const image = create('img');
          image.src = `/agent-${agent.avatar}-v1.png`;
          image.alt = '';
          image.width = 48;
          image.height = 48;
          const label = create('span');
          label.append(
            create('strong', '', agentName(agent)),
            create('small', '', ['TREND', 'REBOUND', 'ROTATION'][index]),
          );
          tab.append(image, label);
          tab.addEventListener('click', () => select(agent.id));
          tab.addEventListener('keydown', (event) => {
            if (
              !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(
                event.key,
              )
            )
              return;
            event.preventDefault();
            const next =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? agents.length - 1
                  : (index +
                      (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1) +
                      agents.length) %
                    agents.length;
            select(agents[next].id);
            $('.desk-tabs').children[next].focus();
          });
          $('.desk-tabs').append(tab);
        });
      }
      let preferred;
      try {
        preferred = sessionStorage.getItem('bi-desk-avatar');
      } catch {}
      const selected =
        agents.find((a) => a.id === activeId) ??
        agents.find((a) => a.avatar === preferred) ??
        agents[0];
      if (selected) select(selected.id);
    },
    setPaused(value) {
      paused = Boolean(value);
      room?.setPaused(paused);
    },
    dispose() {
      disposed = true;
      detailVersion++;
      room?.dispose();
      themeObserver.disconnect();
    },
  };
}
