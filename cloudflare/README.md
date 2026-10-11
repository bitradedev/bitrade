# Cloudflare 部署

生产域名为 `https://bitrade.site`。前台页面、动画、深浅主题、语言、头像、账户和排行榜沿用本机版本。Worker 提供静态文件与 API，SQLite Durable Object 保存账户、FIFO 账本、订单去重、风控与 AI 调度。无需保持本机程序运行。

访问根域名先显示滚动动画；主产品位于 `/home`，账户位于 `/dashboard`。原来的 `/intro` 继续可用，原根地址上的功能锚点会跳转至对应主页区块。

## 模式与配置

Cloudflare 入口把实盘执行固定为关闭；环境变量不能打开签名、广播、充值、提现或密钥恢复。每个模拟 Agent 初始 1000U，没有固定单笔金额上限，仍检查余额、费用、流动性与已授权策略。

三款内置 Agent 使用服务端 AI API 提案和原有趋势、回撤、轮动提示词。每 Agent 最短一分钟评估一次，总调用次数不限；没有合格候选时不为重复观察消耗模型额度。远端模型延迟、行情限频与风控可能推迟评估。退出检查的最短尝试间隔为30秒，按逐个 Agent 分轮调度，并要求确切的卖出报价；模型等待期间不持续轮询行情，交易提案返回后按所选资产刷新证据，再由后续独立轮次撮合。

公开策略详情显示当前持仓实际保存的止盈、止损、最长持有时间和期限；模型输入读取同一份 `exitPlan`。同币追加仓位沿用最早仍持有订单的规则，按整仓扣除退出费用后的美元收益相对总剩余成本触发。持有提案不会调整规则；规则未知明确标记缺失，不从模型新提案推断。触发不等于成交，仍需后续区块重新核价；暂停、过期报价或远端请求延迟可能推迟退出。

退出检查隔离单个币的路线和报价故障，继续检查同账户其他币的止盈、止损与到期。失败持仓保持原金额、成本和规则，公开详情按币与检查时间显示等待重试；报价恢复自动清除提示。共同链头、暂停和执行校验不放宽，外部请求仍受每轮45次预算限制。没有其他可执行退出时，本轮暂缓AI决策，下一轮继续核价。失败后的30秒重试窗口内也暂缓新的AI评估，正常重试核价成功才恢复；跳过重复读取不等于核价通过，不额外消耗数据源或模型额度。

公开用户 Agent 仍在用户自己的运行端配置模型和策略，通过 `/api/agent` 或 `/mcp` 接入。Owner 钱包签名、来源与 CSRF、Agent Token 隔离、关闭归档和公开展示规则保持一致。

## 行情限频与恢复

免费方案调度按轮次分批：每轮最多更新一个候选、收集一份风险报告、评估一个内置 Agent，轮转位置持久保存；新订单在下一轮独立核价成交。每轮外部请求最多45次，低于 Cloudflare 免费的50次限制。所有 RPC、行情和 AI 请求共用该轮预算，轮次之间互相独立；本地预算耗尽不会把健康行情源标成封禁。Gas 预热一次批量读取最多12条真实回执，逐条验证交易和区块，避免重复单笔调用。移除了同一次长模型调用期间不断消耗预算的网络定时轮询。

每 Agent 仍以一分钟为最短评估间隔，总模型次数不限。实际频率由远端模型延迟、行情、排队与风控决定。模型等待使用 Durable Object 的 `waitUntil` 保持后台任务，调度不等待整个模型响应；只允许一个内置决策任务等待，后续轮次继续刷新行情、核对持仓退出及撮合。等待期间每轮最多核对一个持仓 Agent，退出检查以30秒为最短尝试间隔；节点限频或核价失败仍可能推迟退出。成交始终使用后续区块的新报价，不以“按时运行”为由接受过期数据。

模型响应后的刷新和准备订单仍计入启动该决策的原轮45次预算，不因新调度重新获得额度。`networkBudget` 记录最近完成调度的请求数，后台继续使用该轮时计数也继续更新；`decisionBudget` 记录最近决策任务的原预算、开始与完成时间，`decisionInFlight` 显示任务是否还在等待。账户金额、持仓或待处理订单在模型等待期间发生变化时，取消旧提案并等待重新评估；退出核价也拒绝被并发操作改变的旧持仓快照。没有新增对象或迁移，原账本与损失保留。后台保留的语义参考 [Durable Object 状态 API](https://developers.cloudflare.com/durable-objects/api/state/)。

BSC价格节点与回执节点分别共享各自的只读请求队列。节点返回HTTP429后，停止该队列中尚未发送的请求；严格解析Retry-After，遵守有效截止时间并加5秒余量，缺失或较短等待至少退避15秒。冷却按节点身份持久保存，后台重启不重置，回执批次也使用同一机制。没有通过更换节点来绕过限频；价格链头过期或费用资料不足仍不能成交。`/api/runtime` 的 `rpcSources` 显示各节点冷却、失败及恢复记录，不公开节点凭据；行情等待使用价格节点自身的重试时间。正常读取不逐次写入冷却表，避免增加免费方案的SQL写入负担。

生产启用 `BI_TRADE_MEME_ONLY=true`：只允许 BSC Meme 新开仓，CAKE、ETH、BTCB 不再作为候选或备用买入标的。它们的历史、原持仓和保存的退出规则保留；`BI_TRADE_PUBLIC_MARKET=true` 仅继续为这些旧持仓提供独立退出核价。此范围同时约束内置和外部 Agent，在准备及后续区块成交前检查。

独立 Meme 发现使用 Four.meme 公开只读列表，混合热门和近期发行候选，五分钟更新一次、最多12项，逐轮核验且刷新游标持久保存。Four 失败时尝试 GeckoTerminal 的 BSC 池列表；DEX Screener 与 GeckoTerminal 提供池行情互补。列表标签不构成身份凭证：每个新标的必须经 BSC RPC 核验 Four.meme/Flap 发行合约、毕业状态、实际池资产和 Pancake V2/V3 官方工厂。当前仅支持已毕业的 WBNB 外盘、已检出零税的路线，内盘和带税 Meme 暂不参与该独立路径。准确数量由固定区块储备或 Quoter 计算，美元换算使用 Chainlink，费用来自近期实际成交回执；不调用 GMGN 金融接口或签名广播。

`bsc-meme-paper-v1` 为已观测风险模拟政策：Honeypot.is 买卖检测成功、非貔貅、买卖/转账税为零、合约开源无代理、风险标记无中高风险；池流动性至少1万美元、24小时量至少1000美元、至少50个持币地址。前50持仓与链上供应、池及销毁余额对应；仅排除核实的池/销毁地址，其他合约持仓也计入。最大观测持仓不得超过可流通份额10%，前十不得超过50%，已观测的同交易多地址分发不得超过25%。仍执行既有价格一致性、余额、后续区块和单笔不超过池深度1%的条件，没有固定单笔美元上限。

关联检查只读取最近200个区块的真实 ERC20 Transfer，校验合约、区块范围、主题、数量及交易身份，按同一交易多收款地址关联当前持仓。不能覆盖全历史捆绑或原生资金来源；全量捆绑、老鼠仓、同源资金、黑名单能力仍为 null，并在页面与 AI 输入明确披露。状态为 `screened-limited`，不是安全保证。无法取得核心卖出、持仓或身份资料时拒绝新开仓；可选转账样本失败标为未取得，不填造零关联。AI 按原有趋势、回撤、轮动策略自主提案，不强制成交。

Meme 风控优先核对新鲜的新开仓候选，不让禁止再次买入的旧成熟持仓占用唯一风控采集名额。榜单和图表故障不必阻断已有 Meme 的退出：保存的池身份只作为提示，仍重新核对官方工厂、合约代码和当前买卖检测；旧图表时间保留，过期统计清空，不能因此授权新开仓。退出也可能受 RPC 或安全接口故障推迟；不把有限可用性描述为持续稳定。

Four.meme、GeckoTerminal、DEX Screener、Honeypot.is 分别共享串行请求队列与持久缓存；旧持仓与 Meme 使用同一个服务队列，至少2秒间隔、证据复用60秒，限频遵守 Retry-After 且至少退避5分钟。网页刷新不触发直接行情采集，所有读取受原轮45次请求预算约束，耗尽自动等下一轮，不增加免费方案上限。`/api/runtime` 显示来源状态和 Meme 候选范围。所有数据请求均为公开只读接口，不需要购买服务器或新增行情密钥。资料时间过期不能刷新成新证据。

`BSC_RECEIPT_RPC_URL=https://bsc-dataseed.bnbchain.org` 单独采集近期真实成交回执，以估计 Gas。原 Publicnode 匿名端将回执读取视为需要个人凭据的 archive 请求并返回403。公开回执节点须确认 chain ID 56、交易哈希和区块哈希，并与报价节点的同一区块一致；不填造费用样本，也不签名或广播。原页面、账本、Owner 与外部 Agent 接入规则保持。

行情分为独立部分：RPC 负责链头和固定区块成交核价；Chainlink 提供 BNB/USD；公开 Meme 列表提供候选，独立图表和 Honeypot.is 提供市场/安全/持仓采样。GMGN 原标签路径保留但不再是当前 Meme 主链路的依赖，冷却保持，不绕过封禁。BNB/USD 不消耗 GMGN 额度，要求链头不超过15秒、预言机源时间不超过90秒，合约身份、精度和轮次均需校验；预言机失败时才尝试原 GMGN 汇率备源。

平台三款 Agent 和用户账户共享一条 GMGN 串行请求队列与缓存。成功响应在 Durable Object 中保留，服务重启后仍按原始读取时间判断有效性，禁止给旧安全资料重新打时间戳。info、holders、security 和候选列表分别按现有有效期复用；每个用户刷新网页不会直接请求 GMGN。

收到 HTTP 或业务层 429 后，优先遵守 `reset_at`、`X-RateLimit-Reset`、`Retry-After` 中最晚的有效截止时间并加 5 秒余量。连续 `RATE_LIMIT_BANNED` 从 5 分钟逐步退避至最长 1 小时；服务器要求更久时继续遵守。冷却期间不发出 GMGN 探测请求，状态跨重启保留；首次成功后清除连续封禁计数。BSC 链头和独立 BNB/USD 仍可更新，GMGN 失败不再被误报为链断连。`/api/runtime` 的 `marketService` 显示真实冷却状态、下次重试、连续限频次数和最近成功时间。

GMGN 的持续封禁原因仍需服务商确认，不能从429推断 Cloudflare 出口受限。本项目没有换IP、轮换密钥或升级套餐；Meme 主链路使用上述独立模拟政策，并明确缺失的标签能力。没有合格候选且没有持仓时不调用模型，不制造成交。不得因独立接口故障重新添加 CAKE/ETH/BTCB 备用买入池。

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
- 公共数据源按 [RFC 9110 的 Retry-After 定义](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after)区分整数秒数与 HTTP 日期；数字不会同时进入日期解析。429 至少冷却5分钟，有效更长等待仍保留，重启不重置期限。最近HTTP失败的时间、状态及解析后的服务端期限保留，恢复不会修改旧资料年龄。
- 固定CAKE/BTCB/ETH的价格与卖出核价使用BSC RPC、Chainlink及Honeypot.is交易检测，图表限频不会阻断已核实的退出路线。官方工厂池、代码哈希、税和检测年龄仍检查。图表统计只引用原始时间仍有效的缓存，缺失或过期时显示未知；新开仓仍需完整图表、持仓及风控报告，不把可报价等同于可开仓。
- 使用真实 BSC 固定区块报价和近期成交 Gas 样本，保留 Flap、Four.meme、Pancake V2/V3 路线及反向报价。没有签名、发送交易或 GMGN 金融执行接口。
- 初期账本由一个 Durable Object 串行保护，适合早期用户规模。增长后需按账户拆分对象，并把公开排名聚合独立处理。
- 钱包登录在签名验证后重新核对体验会话与当前Owner，仅仍有效且未绑定的体验账户可迁移；并发登录、退出或过期不会覆盖其他钱包的账户归属。绑定与凭据更新使用同一同步事务，既有Agent及账本不迁移到另一个签名者。
- Cloudflare 免费方案有请求、CPU、SQL 读写与存储配额；AI 和 GMGN 也有各自额度。免费额度耗尽会影响服务，应在 Cloudflare 面板观察用量，再决定是否升级。本项目不会自动开通付费方案。
- 保留主密钥与 Cloudflare 存储备份。重新部署代码不会清空账本；不要修改 Durable Object 的固定名称 `bitrade-platform-v1` 或随意新增迁移标签。

Cloudflare 文档：[SQLite 存储](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)、[Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)、[Workers 定价与配额](https://developers.cloudflare.com/workers/platform/pricing/)。
