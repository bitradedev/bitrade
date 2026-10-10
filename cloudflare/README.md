# Cloudflare 部署

生产域名为 `https://bitrade.site`。前台页面、动画、深浅主题、语言、头像、账户和排行榜沿用本机版本。Worker 提供静态文件与 API，SQLite Durable Object 保存账户、FIFO 账本、订单去重、风控与 AI 调度。无需保持本机程序运行。

访问根域名先显示滚动动画；主产品位于 `/home`，账户位于 `/dashboard`。原来的 `/intro` 继续可用，原根地址上的功能锚点会跳转至对应主页区块。

## 模式与配置

Cloudflare 入口把实盘执行固定为关闭；环境变量不能打开签名、广播、充值、提现或密钥恢复。每个模拟 Agent 初始 1000U，没有固定单笔金额上限，仍检查余额、费用、流动性与已授权策略。

三款内置 Agent 使用服务端 AI API 提案和原有趋势、回撤、轮动提示词。每 Agent 最短一分钟评估一次，总调用次数不限；没有合格候选时不为重复观察消耗模型额度。远端模型延迟、行情限频与风控可能推迟评估。退出检查每 30 秒尝试一次，并要求确切的卖出报价。调度中会继续刷新链头和已收集市场，避免 AI 请求期间行情自然过期。

公开用户 Agent 仍在用户自己的运行端配置模型和策略，通过 `/api/agent` 或 `/mcp` 接入。Owner 钱包签名、来源与 CSRF、Agent Token 隔离、关闭归档和公开展示规则保持一致。

## 行情限频与恢复

免费方案调度按轮次分批：每轮最多更新一个候选、收集一份风险报告、评估一个内置 Agent，轮转位置持久保存；新订单在下一轮独立核价成交。每轮外部请求最多45次，低于 Cloudflare 免费的50次限制。所有 RPC、行情和 AI 请求共用该轮预算，轮次之间互相独立；本地预算耗尽不会把健康行情源标成封禁。Gas 预热一次批量读取最多12条真实回执，逐条验证交易和区块，避免重复单笔调用。移除了同一次长模型调用期间不断消耗预算的网络定时轮询。

每 Agent 仍以一分钟为最短评估间隔，总模型次数不限。实际频率由远端模型延迟、行情、排队与风控决定；退出检查以30秒为最短尝试间隔，也可能被网络或模型延迟推迟。成交始终使用后续区块的新报价，不以“按时运行”为由接受过期数据。`networkBudget` 记录最近完成调度的实际请求计数。

生产启用 `BI_TRADE_PUBLIC_MARKET=true`，无需自购服务器或新增行情密钥。BTCB、ETH、CAKE 的成熟外盘可独立读取 DEX Screener 和 Honeypot.is；成交仍由 BSC RPC 对官方 Pancake V2/WBNB 池按确切金额和区块核价，BNB/USD 使用 Chainlink。固定合约、运行时代码哈希、官方工厂与检测池身份均需一致。此路径不调用 GMGN，也不修改 GMGN 冷却状态；新发币继续使用原有完整 GMGN 筛查，不能通过成熟资产名单绕过。

成熟资产采用单独标注的 `established-spot-v1` 虚拟交易政策：官方池运行至少180天、至少10万持币地址、池深度至少50万美元、该池24小时成交量至少1万美元；买卖/转账检测成功且已检出的税为零、开源无代理、运行时代码与固定名单相同。读取前50名持仓并结合链上总供应、销毁地址和该池余额，最大非销毁/非该池持仓不得超过可流通份额35%，前十不得超过90%。合约钱包也计入集中度；不把未知合约钱包排除为流动池。这些阈值只适用于三个长期资产的模拟，不能泛用于新币或真钱。

成熟筛查状态为 `screened-limited`，公开披露 BTCB/ETH 的托管发行和 CAKE 的治理/增发风险；捆绑、老鼠仓、同源资金和黑名单字段为未知，不造出零捆绑或“安全”结论。AI 接收这些限制、真实采样、独立窗口涨跌/交易量数据，按原有趋势、回撤和轮动策略自主决定，不强制买入。安全和持仓报告保留原始读取年龄，过期或失败不能开仓。持仓接口失败不必阻塞已核实的退出报价，仍需有效的当前买卖证据。

DEX Screener、Honeypot.is 各自共享串行请求队列与持久缓存，至少2秒请求间隔，正常证据复用60秒；限频遵守 Retry-After 且至少退避5分钟。页面刷新不重复采集；`/api/runtime` 的 `publicMarketSources` 显示独立来源的连接状态，不能用 GMGN 的冷却来判定全站行情不可用。匿名 GoPlus 在 Cloudflare 实测返回4029，未将它设为该路径的依赖。

`BSC_RECEIPT_RPC_URL=https://bsc-dataseed.bnbchain.org` 单独采集近期真实成交回执，以估计 Gas。原 Publicnode 匿名端将回执读取视为需要个人凭据的 archive 请求并返回403。公开回执节点须确认 chain ID 56、交易哈希和区块哈希，并与报价节点的同一区块一致；不填造费用样本，也不签名或广播。原页面、账本、Owner 与外部 Agent 接入规则保持。

行情分成三个独立部分：BSC RPC 负责链头与固定区块成交核价；Chainlink 的 BSC BNB/USD 标准代理提供美元参考；GMGN 提供候选币、持仓标签、捆绑与合约安全资料。BNB/USD 读取不消耗 GMGN 额度，要求链头不超过 15 秒、预言机源时间不超过 90 秒，合约身份、精度和轮次均需校验。读取失败时才尝试 GMGN 备源；过期价格不能用来成交。

平台三款 Agent 和用户账户共享一条 GMGN 串行请求队列与缓存。成功响应在 Durable Object 中保留，服务重启后仍按原始读取时间判断有效性，禁止给旧安全资料重新打时间戳。info、holders、security 和候选列表分别按现有有效期复用；每个用户刷新网页不会直接请求 GMGN。

收到 HTTP 或业务层 429 后，优先遵守 `reset_at`、`X-RateLimit-Reset`、`Retry-After` 中最晚的有效截止时间并加 5 秒余量。连续 `RATE_LIMIT_BANNED` 从 5 分钟逐步退避至最长 1 小时；服务器要求更久时继续遵守。冷却期间不发出 GMGN 探测请求，状态跨重启保留；首次成功后清除连续封禁计数。BSC 链头和独立 BNB/USD 仍可更新，GMGN 失败不再被误报为链断连。`/api/runtime` 的 `marketService` 显示真实冷却状态、下次重试、连续限频次数和最近成功时间。

持续封禁需要在 GMGN 的 AI API 管理页核对同一密钥的其他使用端、套餐额度和访问配置。Cloudflare 出口是否是原因必须由服务商日志确认，不能从 429 推断。若额度不足，升级 GMGN 套餐或减少候选刷新；若确认不支持 Cloudflare 的共享出口，再使用获准的固定出口只读服务。本项目没有通过换 IP、轮换密钥或跳过风控来规避限频。价格备源不能替代捆绑、持仓和安全资料；新发币资料恢复前不允许它们开仓，三种固定成熟外盘可按上述独立政策运行。没有任何合格候选且没有持仓时不调用模型，不制造模拟成交。

`wrangler.jsonc` 保存公开配置。以下值必须放在 Cloudflare **Worker Secrets**，不能放进 Git、页面代码或客户端存储：

| Secret | 用途 |
| --- | --- |
| `BI_TRADE_VAULT_KEY` | 32 字节 Base64 主密钥，保管后续备份；迁移必须沿用原密钥 |
| `BI_TRADE_AI_API_KEY` | 支持 Responses API / JSON Schema 的 AI 服务商密钥 |
| `GMGN_API_KEY` | 只读行情、持仓与安全信息；不需要 GMGN 交易私钥 |
| `BI_TRADE_MIGRATION_TOKEN` | 首次私有账本导入授权，完成后删除 |

AI 服务地址和模型通过 `BI_TRADE_AI_BASE_URL` / `BI_TRADE_AI_MODEL` 配置。`BI_TRADE_SHOWCASE_PAUSED=true` 可以暂停平台三款展示 Agent；用户账户自己的暂停状态独立保存。

## 安装与验证

若服务商确认 Cloudflare 直连与其访问策略不兼容，可按 [独立只读行情中继](../market-relay/README.md) 部署获准的固定 IPv4 出口，再配置 `GMGN_RELAY_URL` 和 `GMGN_RELAY_TOKEN`。当前未配置这两个值，生产继续使用直连；不能把中继代码准备完等同于行情或 Agent 已恢复。公开 Agent 状态会区分等待行情和等待风险核验，行情冷却时显示单独的连接尝试时间。

需要 Node.js 24 和 pnpm 11.25。根目录安装依赖即可构建云端，不必启动本机行情进程。

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm test:cloud
pnpm build:cloud
```

云端测试使用真正的 Workerd 和 SQLite，验证页面字节、账户隔离、原生网络调用、重启恢复、资金锁定、限频等待和账本合并。行情适配器仍可用原来的 `paper-terminal` 测试独立验证。

## 从已有本机实例迁移

在仓库根目录运行，路径参数指向旧的 `bi-trade` 目录：

```sh
node cloudflare/scripts/prepare-local.mjs /path/to/existing/bi-trade
pnpm cloud:dev
```

脚本只把所需服务端密钥写入忽略的 `.dev.vars`，把迁移快照保存到忽略的 `cloudflare/data/`。预览地址为 `http://127.0.0.1:8796`，展示 Agent 默认暂停。不要同时长期开着旧行情服务与预览，它们共享同一 GMGN 额度。

确认旧实例没有待核对的实盘操作后，暂停本机展示 Agent 并重新准备最后快照，再发布：

```sh
node cloudflare/scripts/pause-local-showcase.mjs /path/to/existing/bi-trade
node cloudflare/scripts/prepare-local.mjs /path/to/existing/bi-trade
pnpm exec wrangler login
node cloudflare/scripts/publish-secrets.mjs
pnpm exec wrangler deploy --var BI_TRADE_SHOWCASE_PAUSED:true
node cloudflare/scripts/import-ledger.mjs https://bitrade.site
pnpm cloud:deploy
pnpm exec wrangler secret delete BI_TRADE_MIGRATION_TOKEN
```

导入会等待正在运行的调度结束，合并旧账本，保留新建的云端用户和登录会话；若云端展示账户已有成交，则拒绝覆盖。相同快照的重试不会再次导入。原钱包地址、成交、费用和亏损全部保留；未完成的本机模拟订单取消，不补造离线成交。旧登录凭据和配对链接不迁移，钱包用户重新签名登录、外部 Agent 重新配对。本机匿名体验账户无法自动跨域登录，旧数据保留在原实例及私有快照中。

上线后停止旧本机服务和预览，避免重复采集和模型调用。不要删除原账本、主密钥或私有快照，确认备份后再自行处理。

## 运行与限制

- `/api/health` 检查服务和实盘锁；`/api/runtime` 提供不含密钥的行情、候选、调度状态和限频恢复时间。
- GMGN 请求共用队列。429 遵守返回的恢复时间，并降低采集速度；风控缓存保留实际读取时间，不刷新旧数据的年龄。缺数据、未知税或过期报价均不制造模拟成交。
- 使用真实 BSC 固定区块报价和近期成交 Gas 样本，保留 Flap、Four.meme、Pancake V2/V3 路线及反向报价。没有签名、发送交易或 GMGN 金融执行接口。
- 初期账本由一个 Durable Object 串行保护，适合早期用户规模。增长后需按账户拆分对象，并把公开排名聚合独立处理。
- Cloudflare 免费方案有请求、CPU、SQL 读写与存储配额；AI 和 GMGN 也有各自额度。免费额度耗尽会影响服务，应在 Cloudflare 面板观察用量，再决定是否升级。本项目不会自动开通付费方案。
- 保留主密钥与 Cloudflare 存储备份。重新部署代码不会清空账本；不要修改 Durable Object 的固定名称 `bitrade-platform-v1` 或随意新增迁移标签。

Cloudflare 文档：[SQLite 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[Workers 定价与配额](https://developers.cloudflare.com/workers/platform/pricing/)。
