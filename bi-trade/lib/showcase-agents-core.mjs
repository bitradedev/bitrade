import { identifier, fail } from './database-core.mjs';
import { readAIConfig, OpenAIPlanner, validateDecision, reserveAICall } from './ai-provider.mjs';
import { viem } from './dependencies.mjs';
import { v2Abi, ROUTER_V2, WBNB } from './bsc-rpc.mjs';
import { showcasePositions } from './showcase-exits.mjs';

export const SHOWCASE_PROFILES = [
  {
    id: 'showcase-trend',
    name: 'BI 趋势猎手',
    strategy: {
      name: '趋势动量',
      description:
        '比较实际价格采样的方向和持续性，寻找趋势机会；结合可用流动性、费用和退出条件决定仓位。数据不足时观察。',
      version: 1,
    },
  },
  {
    id: 'showcase-rebound',
    name: 'BI 回撤观察员',
    strategy: {
      name: '回撤反弹',
      description:
        '研究实际采样中的回撤与企稳迹象，避免仅因价格下跌买入；为每笔入场设定止损、止盈与最长持有时间。',
      version: 1,
    },
  },
  {
    id: 'showcase-rotation',
    name: 'BI 轮动研究员',
    strategy: {
      name: '相对强弱轮动',
      description:
        '比较候选市场的实际价格表现与可用深度，研究资金轮动；评估持仓退出成本后决定买入、卖出或保持观察。',
      version: 1,
    },
  },
];
export class ShowcaseAgents {
  constructor({
    store,
    vault,
    paper,
    gateway,
    execute,
    planner = new OpenAIPlanner(),
    riskGuard,
    configReader,
    maxAgentsPerRun = SHOWCASE_PROFILES.length,
    now = () => Date.now(),
  }) {
    Object.assign(this, { store, vault, paper, gateway, execute, planner, riskGuard, now });
    this.configReader = configReader ?? (() => readAIConfig(store, vault));
    this.stopped = false;
    this.task = null;
    this.controller = null;
    this.maxAgentsPerRun = Math.max(1, Math.min(SHOWCASE_PROFILES.length, maxAgentsPerRun));
    this.sampleAt = 0;
    this.tickAt = 0;
    this.exitChecks = new Map();
    this.checkingExits = new Set();
    this.watching = null;
    this.watchCursor = 0;
    store.transaction(() => {
      for (const p of SHOWCASE_PROFILES) {
        let a = store.get('agents', p.id);
        if (!a)
          a = {
            ...p,
            ownerId: 'platform-showcase',
            source: 'builtin',
            ...vault.create(p.id),
            mode: 'paper',
            paused: false,
            public: true,
            policy: { mode: 'balance' },
            createdAt: now(),
          };
        if (a.ownerId !== 'platform-showcase' || a.source !== 'builtin')
          throw Error('内置Agent标识冲突');
        a = { ...a, ...p, mode: 'paper', public: true };
        store.put('agents', a);
        paper.account(a.id);
        const previous = store.get('showcase-status', a.id);
        store.put('showcase-status', {
          ...previous,
          id: a.id,
          state: 'observing',
          reason: '等待核对行情与 AI 配置',
          nextDecisionAt: previous?.nextDecisionAt ?? 0,
        });
      }
    });
  }
  status(id, patch) {
    const old = this.store.get('showcase-status', id) ?? { id };
    return this.store.put('showcase-status', { ...old, ...patch, checkedAt: this.now() });
  }
  sample() {
    if (this.now() - this.sampleAt < 30000) return;
    this.sampleAt = this.now();
    for (const m of this.freshMarkets()) {
      const id = m.address,
        t = this.store.get('market-tapes', id) ?? { id, samples: [] };
      if (t.samples.at(-1)?.sourceAt === m.updatedAt) continue;
      t.samples.push({ at: this.now(), sourceAt: m.updatedAt, priceUsd: m.priceUsd });
      t.samples = t.samples.filter((x) => this.now() - x.at <= 6 * 3600000).slice(-60);
      this.store.put('market-tapes', t);
    }
  }
  freshMarkets() {
    return this.gateway
      .markets()
      .filter(
        (m) =>
          m.chain === 'bsc' &&
          m.quality === 'verified' &&
          this.now() - m.updatedAt >= 0 &&
          this.now() - m.updatedAt <= 15000 &&
          Number.isFinite(m.priceUsd) &&
          m.priceUsd > 0,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 24);
  }
  context(a) {
    const head = this.paper.head(),
      fx = this.paper.fx();
    if (!fx) throw fail('等待新鲜 BNB 美元行情');
    this.paper.seed(a.id, fx);
    const v = this.paper.view(a.id);
    return {
      at: this.now(),
      chainId: 56,
      block: head.head,
      account: {
        initialUsd: v.initialUsd,
        balanceUsd: v.balanceUsd,
        realizedUsd: v.realizedUsd,
        positions: showcasePositions(this.store, v.positions).map((p) => ({
          token: p.token,
          symbol: p.symbol,
          amountRaw: p.amountRaw,
          costUsd: p.costUsd,
          estimatedValueUsd: v.positions
            .filter((lot) => lot.token === p.token)
            .every((lot) => Number.isFinite(lot.estimatedValueUsd))
            ? v.positions
                .filter((lot) => lot.token === p.token)
                .reduce((n, lot) => n + lot.estimatedValueUsd, 0)
            : null,
          exitPlan: p.exitPlan,
          risk: this.riskGuard.snapshot(p.token, this.gateway.getMarket('bsc', p.token)?.priceUsd),
        })),
      },
      markets: this.freshMarkets().map((m) => ({
        token: m.address,
        symbol: String(m.symbol ?? '').slice(0, 60),
        platform: m.platform ?? m.venue ?? null,
        stage: m.stage ?? null,
        priceUsd: m.priceUsd,
        liquidityUsd: m.liquidityUsd ?? null,
        volumeUsd: m.volumeUsd ?? null,
        dataSource: m.dataSource ?? null,
        marketDataAt: m.marketDataAt ?? null,
        priceChange: m.priceChange ?? null,
        transactions: m.transactions ?? null,
        buyTaxPct: m.buyTaxPct ?? null,
        sellTaxPct: m.sellTaxPct ?? null,
        updatedAt: m.updatedAt,
        risk: this.riskGuard.snapshot(m.address, m.priceUsd),
        prices: (this.store.get('market-tapes', m.address)?.samples ?? []).slice(-16),
      })),
    };
  }
  async sell(a, token, reason, key) {
    const amount = this.paper
      .lots(a.id)
      .filter((p) => p.token === token)
      .reduce((n, p) => n + BigInt(p.remainingRaw), 0n);
    if (amount <= 0n) throw fail('没有可卖出的模拟持仓');
    return this.execute(a, 'submit_transaction', {
      to: ROUTER_V2,
      data: viem.encodeFunctionData({
        abi: v2Abi,
        functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
        args: [amount, 0n, [token, WBNB], a.address, BigInt(Math.floor(this.now() / 1000) + 180)],
      }),
      value: '0',
      requestKey: key,
      reason,
    });
  }
  accountBasis(id) {
    const a = this.paper.account(id);
    return JSON.stringify([
      this.paper.revision,
      a.nativeRaw,
      a.realizedNativeRaw,
      this.paper.lots(id).map((lot) => [lot.id, lot.remainingRaw, lot.usdCost]),
      this.paper
        .orders(id)
        .filter((o) => ['preparing', 'queued', 'quoting'].includes(o.status))
        .map((o) => [o.id, o.status]),
    ]);
  }
  async checkExits(a) {
    if (this.checkingExits.has(a.id)) return null;
    if (this.now() - (this.exitChecks.get(a.id) ?? 0) < 30000) return false;
    this.exitChecks.set(a.id, this.now());
    this.checkingExits.add(a.id);
    try {
      return await this.exits(a);
    } finally {
      this.checkingExits.delete(a.id);
    }
  }
  watchExits() {
    if (this.watching || this.stopped) return this.watching;
    this.watching = (async () => {
      const eligible = SHOWCASE_PROFILES.map((p) => this.store.get('agents', p.id)).filter(
        (a) =>
          a &&
          !a.closedAt &&
          !a.paused &&
          a.mode === 'paper' &&
          !this.paper.view(a.id).pending &&
          this.paper.lots(a.id).length &&
          !this.checkingExits.has(a.id) &&
          this.now() - (this.exitChecks.get(a.id) ?? 0) >= 30000,
      );
      if (!eligible.length) return;
      const a = eligible[this.watchCursor++ % eligible.length];
      try {
        await this.checkExits(a);
      } catch (e) {
        this.status(a.id, {
          state: 'observing',
          reason: e.status ? e.message : '暂无法核对持仓退出报价',
        });
      }
    })().finally(() => {
      this.watching = null;
    });
    return this.watching;
  }
  async exits(a) {
    const failures = [],
      basis = this.accountBasis(a.id),
      positions = showcasePositions(this.store, this.paper.lots(a.id));
    this.status(a.id, { exitFailures: failures });
    for (const position of positions) {
      if (this.accountBasis(a.id) !== basis) throw fail('持仓在核价期间改变，稍后重新检查');
      const { token, amountRaw, costUsd, exitPlan } = position,
        rule = exitPlan.rule;
      if (!rule) continue;
      const head = this.paper.head();
      let q;
      try {
        q = await this.paper.quote(a, 'sell', token, amountRaw, head.head);
        if (q.spentInputRaw !== q.inputRaw) throw fail('整仓退出报价尚未核实');
        if (this.accountBasis(a.id) !== basis) throw fail('持仓在核价期间改变，稍后重新检查');
      } catch {
        failures.push({ token, at: this.now() });
        this.status(a.id, { exitFailures: [...failures] });
        // A token-specific route or quote failure must not block other tokens'
        // automatic exits. Shared head, pause and execution failures still stop.
        continue;
      }
      const proceeds =
          (Number(BigInt(q.outputRaw)) / 1e18) * q.nativeUsd - q.fees.gasUsd - q.fees.approvalUsd,
        pct = (proceeds / costUsd - 1) * 100,
        age = (this.now() - exitPlan.openedAt) / 60000;
      const trigger =
        pct >= rule.takeProfitPct
          ? '止盈'
          : pct <= -rule.stopLossPct
            ? '止损'
            : age >= rule.maxHoldMinutes
              ? '持有时间到期'
              : null;
      if (trigger) {
        const reason =
          trigger + '：整仓可执行报价收益 ' + pct.toFixed(2) + '%，含退出 Gas；再次核价后成交。';
        const order = await this.sell(a, token, reason, 'exit-' + identifier());
        this.status(a.id, { state: 'queued', reason, orderId: order.id });
        return true;
      }
    }
    if (failures.length)
      throw fail('部分持仓退出报价暂不可用；其他持仓已继续核对，稍后自动重试。', 503);
    return false;
  }
  tick() {
    if (this.task || this.stopped || this.now() - this.tickAt < 5000) return this.task;
    this.tickAt = this.now();
    this.task = this.run()
      .catch(() => {})
      .finally(() => {
        this.task = null;
      });
    return this.task;
  }
  async run() {
    this.sample();
    const held = SHOWCASE_PROFILES.flatMap((p) => this.paper.lots(p.id).map((l) => l.token));
    this.riskGuard.tick([
      ...held,
      ...SHOWCASE_PROFILES.flatMap((p) =>
        this.paper
          .fills(p.id)
          .filter((f) => f.side === 'buy')
          .sort((a, b) => b.at - a.at)
          .slice(0, 1)
          .map((f) => f.token),
      ),
      ...this.freshMarkets().map((m) => m.address),
    ]);
    let config;
    try {
      config = this.configReader();
    } catch {
      for (const p of SHOWCASE_PROFILES)
        this.status(p.id, { state: 'error', reason: 'AI 配置无法读取，请在本机重新配置。' });
      return;
    }
    const cursor = this.store.get('showcase-cursor', 'platform')?.next ?? 0;
    const profiles = Array.from(
      { length: this.maxAgentsPerRun },
      (_, i) => SHOWCASE_PROFILES[(cursor + i) % SHOWCASE_PROFILES.length],
    );
    if (this.maxAgentsPerRun < SHOWCASE_PROFILES.length)
      this.store.put('showcase-cursor', {
        id: 'platform',
        next: (cursor + this.maxAgentsPerRun) % SHOWCASE_PROFILES.length,
      });
    for (const p of profiles) {
      if (this.stopped) return;
      const a = this.store.get('agents', p.id);
      if (a.mode !== 'paper') {
        this.status(a.id, { state: 'error', reason: '内置展示账户仅支持模拟模式' });
        continue;
      }
      if (a.paused) {
        this.status(a.id, { state: 'paused', reason: '展示 Agent 已暂停' });
        continue;
      }
      if (this.paper.view(a.id).pending) {
        this.status(a.id, { state: 'queued', reason: '模拟订单等待后续区块重新核价' });
        continue;
      }
      const previous = this.store.get('showcase-status', a.id),
        last = previous?.orderId ? this.store.get('paper-orders', previous.orderId) : null;
      if (
        previous?.state === 'queued' &&
        last &&
        !['queued', 'quoting', 'preparing'].includes(last.status)
      )
        this.status(a.id, {
          state: ['filled', 'partial'].includes(last.status) ? 'observing' : 'error',
          reason: ['filled', 'partial'].includes(last.status)
            ? '最近模拟订单已成交。' + (last.reason ?? '')
            : last.error || '最近订单未成交',
        });
      try {
        const checked = await this.checkExits(a);
        if (checked === null || checked) continue;
      } catch (e) {
        this.status(a.id, {
          state: 'observing',
          reason: e.status ? e.message : '暂无法核对持仓退出报价',
        });
        continue;
      }
      if (!config) {
        this.status(a.id, {
          state: 'needs-config',
          model: null,
          nextDecisionAt: 0,
          reason: '等待站点管理员配置 AI API 密钥；尚未启动 AI 决策。',
        });
        continue;
      }
      const validation = this.store.get('ai-validation', 'provider'),
        saved = this.store.get('settings', 'ai-provider');
      if (saved && validation?.configurationUpdatedAt === saved.updatedAt && !validation.valid) {
        this.status(a.id, {
          state: 'error',
          model: config.model,
          nextDecisionAt: 0,
          reason: validation.reason,
        });
        continue;
      }
      const state = this.store.get('showcase-status', a.id);
      if (this.now() < (state.nextDecisionAt ?? 0)) continue;
      let context;
      try {
        context = this.context(a);
        if (!context.markets.length && !context.account.positions.length)
          throw fail(this.gateway.marketReason?.() ?? '等待新鲜且已核实的 BSC 候选市场');
      } catch (e) {
        const wait = this.gateway.marketWait?.();
        this.status(a.id, {
          state: 'waiting-market',
          model: config.model,
          nextDecisionAt: 0,
          marketRetryAt: wait?.retryAt ?? null,
          reason: e.status ? e.message : '等待 BSC 行情恢复',
        });
        continue;
      }
      if (!context.account.positions.length && !context.markets.some((m) => m.risk.buyAllowed)) {
        this.status(a.id, {
          state: 'waiting-risk',
          model: config.model,
          marketRetryAt: null,
          nextDecisionAt: this.now() + config.intervalMinutes * 60000,
          reason: '尚无通过持仓风险筛查的候选；数据缺失或风险过高时暂不开仓。',
        });
        continue;
      }
      if (!reserveAICall(this.store, config, this.now())) {
        this.status(a.id, {
          state: 'quota',
          model: config.model,
          reason: '今日 AI 调用额度已用完；持仓退出检查继续。',
        });
        continue;
      }
      this.status(a.id, {
        state: 'thinking',
        marketRetryAt: null,
        model: config.model,
        nextDecisionAt: this.now() + config.intervalMinutes * 60000,
        reason: 'AI 正在评估真实行情和当前模拟持仓',
      });
      this.controller = new AbortController();
      const basis = this.accountBasis(a.id);
      try {
        const decision = validateDecision(
          await this.planner.decide(config, a.strategy, context, this.controller.signal),
          context,
        );
        if (this.stopped) return;
        const current = this.store.get('agents', a.id);
        if (current.paused || current.mode !== 'paper')
          throw fail('决策期间 Agent 已暂停或模式变化');
        if (this.accountBasis(a.id) !== basis)
          throw Object.assign(
            fail('AI 评估期间账户或持仓已变化，旧提案已取消，等待重新评估。', 409),
            { code: 'STALE_AI_ACCOUNT' },
          );
        this.status(a.id, {
          lastDecisionAt: this.now(),
          decision,
          reason: decision.reason,
          state: 'observing',
        });
        if (decision.action === 'hold') continue;
        let order;
        if (decision.action === 'buy') {
          const fx = this.paper.fx();
          if (!fx) throw fail('决策后 BNB 美元行情已过期');
          const size = String(BigInt(Math.floor((decision.sizeUsd / fx) * 1e18)));
          order = await this.execute(current, 'buy_token', {
            token: decision.token,
            amount: size,
            requestKey: 'ai-' + identifier(),
            reason: decision.reason,
          });
          this.store.put('showcase-exits', {
            id: order.id,
            agentId: a.id,
            token: decision.token,
            ...decision.exit,
            orderId: order.id,
          });
        } else
          order = await this.sell(current, decision.token, decision.reason, 'ai-' + identifier());
        this.status(a.id, { state: 'queued', reason: decision.reason, orderId: order.id });
      } catch (e) {
        if (!this.stopped)
          this.status(a.id, {
            state:
              e.code === 'STALE_AI_ACCOUNT'
                ? this.paper.view(a.id).pending
                  ? 'queued'
                  : 'observing'
                : 'error',
            reason: e.status ? e.message : 'AI 决策本轮未执行，请检查本机服务。',
          });
      } finally {
        this.controller = null;
      }
    }
  }
  async stop() {
    this.stopped = true;
    this.controller?.abort();
    await this.riskGuard.close();
    await this.task;
    await this.watching;
  }
}
