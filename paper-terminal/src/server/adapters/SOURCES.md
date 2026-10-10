# 只读网关的来源与接口

`LiveGateway` 实现 `shared/domain.ts` 的 `MarketGateway`。构造参数是
`{dataDir?, proxy?, wallets?: Partial<Record<Chain, {address,name}[]>>, onAudit?: (kind,message,details?)=>void}`。
附加接口：`nativePrice(chain)`、`snapshot(chain, token)`、`reprice(snapshot, exactSizeRequest)`。
`retainTokens(chain, tokens)` 替换该链当前持仓/外部引用的保留列表，主服务可在启动、恢复及持仓变动后调用。`addToken(chain, token, background=false)` 默认前台；内部发现与研究传 true，不把自动发现的币当手动保留。
`selectToken(chain, token)` 同步保留目录中已有的代币并返回当前 FX，不进行元数据、RPC 或报价读取。未知条目返回 MARKET_UNKNOWN，需要显式添加。
`candles()` 仍返回 Candle 数组；可另调用 `candleStatus(chain, token)` 取得 source、pending、reason、state、rows、historyAt。缓存/已采集数据立即返回，空冷查询最多等1500ms，历史读取后台继续、同币请求合并。主服务可返回 `{candles, ...gateway.candleStatus?.(chain,token)}`。无数据、读取中和错误是不同状态，不插值、不生成演示 K 线。
`cachedCandles(chain, token): Candle[]` 是同步、无网络/刷新副作用的纯缓存读取，供独立图表 SSE 使用；每币最多1000行并返回副本，不把全部图表塞入主状态广播。若最新已核实本地成交发生在历史查询截止后，只更新匹配的末根 K 线，成交量取本机实际采集量并明确提示可能不完整；不把历史与本地重叠成交量相加，旧历史柱保持原数据，不用市场参考价制造新柱。Main 可用250ms专用图表流推送变化，主状态流仍维持2秒。
`selectPool(chain,token,pool)` 可指定已通过官方工厂与资产校验的 V2/V3 池。`LiveQuote` 另返回 `impactQuality` 和 `sourceFeeFrozenAt`（本机毫秒时间戳）。`GasContext` 也从网关导出。
`snapshot` 固定区块哈希及捕获时的真实 FX；`reprice` 按确切金额调用历史区块报价，不能线性缩放另一笔报价。

原生币单位是 raw18。买入 `inputRaw = spentInputRaw + refundRaw`；卖出 `outputRaw` 为净原生币，`inputRaw` 为实际 token 精度。
`markets()`/`getMarket()` 的 nativeUsd 来自该链当前90秒内的真实 FX 缓存，缺失/过期返回 null；读取 FX 不改变代币 priceUsd、updatedAt、quality。已存在精度与 Pons 路由证明的手动 addToken 立即返回，避免加入尚未完成的后台 resolver 或等待展示元数据；实际交易仍要求精确报价通过。
`fees.includedInOutput = true` 只针对协议/税/兑换明细；`gasUsd` 和 `approvalUsd` 始终在报价金额外。
费用明细的美元归因、近期真实成交 gasUsed × 当前 gasPrice、首次授权预算标为 estimated；已核实的路线整数数量标为 verified。
`priceImpactPct` 衡量订单大小造成的流动性冲击，排除已知协议、创作者及反狙击费用；多步兑换各步冲击保守相加。V4 Hook 费用归因的冲击标为 estimated；费用依然全部进入往返净损失检查。
不接受 source wallet 的豁免：Pons/Flap 尊重 Broker 提供的独立随机模拟账户 recipient；观察钱包地址会被拒绝。展示参考报价另用进程随机地址。

## 一手资料

- Pons V2 阶段、phantom reserves、整数费用、反狙击税、部分成交退款：<https://docs.ponsfamily.com/v2>
- Pons V1 官方部署、池与配额：<https://docs.ponsfamily.com/>
- Pons Solidity（某些已部署新增 getter 比仓库旧版本更新，缺失时阻断）：<https://github.com/ponsdotdev/pons-labs>
- Flap 最新 StateV8Safe 与价格精度：<https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-token>
- Flap quoteExactInput / eth_call、曲线与迁移：<https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens>
- Four Helper3 与税费语义：<https://github.com/four-meme-community/fourmeme-docs/blob/main/contracts/interfaces/ITokenManagerHelper3.sol>
- Four 模板与税率单位：<https://github.com/four-meme-community/fourmeme-docs/blob/main/docs/tax-guide.md>
- Pancake 官方 V2/V3 工厂与 Quoter：<https://developer.pancakeswap.finance/contracts/v2/addresses>、<https://developer.pancakeswap.finance/contracts/v3/addresses>
- Uniswap 官方 Robinhood V4 部署：<https://developers.uniswap.org/docs/protocols/v4/deployments>
- V4 Quoter ABI：<https://github.com/Uniswap/v4-periphery/blob/main/src/interfaces/IV4Quoter.sol>

## 范围与阻断

运行中 selectToken 对已选择市场启动异步历史预取，方法本身仍同步返回，不等待元数据。每链最多一个选择，预取至多两个待处理历史任务；仅在链头新鲜及最近30秒有选择/该选择的 candles 读取需求时工作。沿用15秒成功缓存及失败重试间隔、45秒请求期限与原2200ms全局 CLI 队列，不另开网络预算；停止/空闲后不持续预取。cachedCandles/candleStatus 仍不发请求。既有 resolver/hydration 等待队列优先处理当前选择，扫描仍最多100个池/曲线地址，并保留老的选中路线在该范围中；两链路线不会串用。
V2/V3 行情与成交处理复用官方工厂/资产/池身份核实时已读取的 token0/token1，最多300个池证明，保留首次核实区块；早于该区块及重组后沿用原始 exact-block getter，单独 getter 不建立工厂证明。重组中迟到的证明不能回填缓存。储备、slot0、所有动态报价、税与 Gas 读取原样保留，成交仍逐笔要求成功回执、同块哈希及协议净流匹配。固定资产语义的一手代码为 [Pancake V2 Pair](https://raw.githubusercontent.com/pancakeswap/pancake-swap-core/master/contracts/PancakePair.sol)、[Pancake V3 Pool](https://raw.githubusercontent.com/pancakeswap/pancake-v3-contracts/main/projects/v3-core/contracts/PancakeV3Pool.sol)、[Uniswap V3 Pool](https://raw.githubusercontent.com/Uniswap/v3-core/main/contracts/UniswapV3Pool.sol)。

扫链显示字段 `scannerStage` / `scannerAt` / `progressPct` 与报价准入独立。GMGN trenches 的 `new_creation`、`near_completion`、`completed` 原始键分别映射新盘、即将毕业、已毕业，并保留 `metadata.scanner` 来源。已核实 DEX 路线或协议毕业事件优先，不被后续旧 near 分类或滞后的内盘读取覆盖；重组撤销受影响证明。内盘默认 new，只有90秒内实际 near 分类或已核实 ready/phase-1 状态才显示 near，过渡期卖出限制继续阻断。
重组撤销阶段时，`Market.stage` 同步恢复为仍在重组边界以前的有效路线证明阶段；没有该证明则置 unknown。不存在有效扫链证明时省略 scannerStage/scannerAt，progressPct 为 null，避免前端回退到已撤销的 dex；较早、仍有效的毕业事件可继续提供 scannerStage，前端以合并后的明确分类优先。适配器测试直接将网关 JSON 市场送入实际前端分类函数，核对重组后未知、旧 DEX 保留、毕业事件先到及撤销毕业回到旧曲线四种状态。
未解析市场的平台展示使用同一条 GMGN 种子记录中已用于协议筛选的 launchpad_platform，仅填充空值或“待核实”；已有链上路线平台不覆盖。此展示字段不建立路线证明、不读取新价格格式，也不升级 quality、priceUsd、decimals 或交易资格。
进度只使用安装的 GMGN CLI 所声明的0～1 `progress` 字段乘100；缺失、非法或未知 ABI 单位为 null，不按分类猜百分比，不因外盘路线而补100。分类冲突及过期进度不沿用。排序采用实际 `created_timestamp` / `creation_timestamp`，毕业优先使用实际 `complete_timestamp` 或已取得时间的毕业区块；未知时间省略 scannerAt，不以本机发现时间替代。链上创建时间优先，原始时间保留并按既有链头时钟映射。
上述 GMGN 字段单位的一手依据为安装的 `gmgn-cli/dist/commands/market.js`（progress 0～1）及实际只读结果 `fixtures/live-verification.json`（complete_timestamp 与 created_timestamp 为 Unix 秒）。保存样本的 BSC 三类和 RH near/completed 均有已接入协议条目；该样本没有已接入协议的 RH new 条目，不能填造。此改动没有新增网络请求、提高每类抓取上限或扩大交易权限。

目录每链最多150个条目，两链互不挤占；每链手动选择/前台报价与持仓引用合计保留最多50个。持仓引用优先，手动引用按最近使用保留；引用列表超过50会拒绝，不能静默删除持仓引用。手动引用随目录持久化；恢复的实际持仓列表由主服务调用 retainTokens 再绑定。淘汰只移除未保留条目，并清掉相应路由/元数据，不更改任何账户或持仓。
Pons V2 官方费用文档明确 feeBps/creatorTaxBps 在创建后固定，可按已核实曲线缓存。本实现保留第一次读取的证明区块，早于它或重组时重新读取；储备、sellableTokens、readyToGraduate、graduated 仍按请求区块读取，买入 currentSnipeTaxBps 始终传实际 recipient。预热后每次买入需5个动态 getter，卖出4个；卖出不查询不适用的反狙击税，未放宽5秒限制或伪造阶段/价格。

只允许公开 RPC 和 GMGN token info/security/pool、trenches/kline。没有私钥、wallet client、签名、交易广播或 GMGN 浏览器访问。
所有网关实例的 GMGN 请求共用一个进程内队列和跨进程锁，开始间隔至少 2200ms；限频有共享冷却。
GMGN 队列只有一个在途任务，交互 K 线优先于等待中的后台元数据；相同优先级按所有者轮流服务，所有者内维持次序。最多128个等待任务、每个所有者16个；支持取消，停止网关只取消自己的任务。跨进程锁/请求间隔尚未就绪时，释放锁并让调度器重新挑选任务，不在持锁睡眠时阻挡交互请求；已发送的任务仍共用同一预算，不额外开通道。共享限频冷却立即返回明确原因。
30s 是安装的 CLI 明确支持的免费分辨率；CLI --from/--to 输入 Unix 秒，命令内部乘1000后传 API。成功响应的 data.list（或数组）会校验，无法识别格式或所有数值无效会报错，不能默默当作“没有成交”。实际 time 毫秒与 volume USD 按真实字段归一化。
K 线历史缓存和失败重试间隔为15秒，最多100个历史条目。本地 K 线只由成功回执及协议净流核实的真实成交产生；重组清除受影响链的本地/历史数据，迟到旧请求不覆盖新状态。缺少链头时保留历史服务原始时间，不把全部历史数据折叠成“现在”。
所有 ReadRpc 实例、两条链和 HTTP/已接入 WS 日志读取共用同一进程内调度预算：开始间隔180ms，最多3个在途读取。排序是链头、前台、后台；同优先级保持请求序号。最多1个链头在途，最多2个普通读取，后台最多占1个普通读取，保留链头与至少1个前台容量。不存在优先请求绕过预算的额外并发通道。GMGN 跨进程锁保持原状；RPC 预算不宣称跨独立操作系统进程共享。
`quote(request)` 默认前台；主服务传 `background:true` 时走后台。扫描、行情 refresh、snapshot/reprice 走后台；钱包核实与退出估值默认前台。队列最多192个等待请求，后台/前台/链头各有上限128/48/16，满队列、限频、过期、停止均返回明确错误。前台整次报价与链头读取最多等待5秒；后台单次请求最多15秒。429共享冷却也约束链头，不能把节点限频伪装成在线。
缓存中尚未发送的共享读取可提升优先级，不额外复制网络请求。已经发出的读取不会通过重发绕过并发限制；原 ChainFeed 的单个 WS RPC 不可取消，调用者超时后其槽位仍保留至原请求结束。`ReadRpc.queueStats()` 提供实际队列与在途计数。停止只取消对应网关实例的工作。
原生币 FX 刷新去重：前台直接使用90秒内的真实 FX 缓存，即使后台有更慢的刷新；运行中缺失或过期时立即阻断为 FX_NOT_READY/FX_STALE，并触发后台刷新，不等待 GMGN 全局元数据队列，不猜价格。BSC 实际协议日志在价格读取前即可提供近期 Gas 样本；HTTP 免费节点日志受限时通过真实区块交易回执取样，避免全球 AMM 大范围日志查询。
GasContext 按协议种类、固定区块缓存并冻结真实回执样本；同一区块各协议共用一次真实 gasPrice 读取。`sourceFeeFrozenAt` 是该 RPC 返回时刻，不能冒充区块产生时刻。Gas 价格与上下文缓存上限分别128/256，失败结果不留缓存；不同预算的买入与反向卖出仍依次报价。
运行中已知链头新鲜、指定区块不高于它时，不再重复读取 latest 区块；区块时间来自实际 HTTP/WS 头及有界缓存，缺失的旧区块头读取一次核实年龄。HTTP 落后于 WS 不会把已知 WS 区块当未来区块。固定区块 eth_call 核实状态可读；重组清除费用、区块、兑换及反向预览缓存，正在返回的旧报价会拒绝。
DEX 路由缓存的区块是首次核实工厂/池身份的下界，不随行情刷新推进；稍早、仍晚于该证明区块的固定区块报价直接复用路线，动态数量与价格仍在所请求的精确区块读取。早于证明区块必须重新核实，重组清空证明；内盘状态仍按固定区块重读。此处避免 RH 快速新区块使同一 V1 DEX 反复读取各工厂。
BSC 使用既有未修改的 ChainFeed；Robinhood 官方 HTTP 轮询，不把 sequencer feed 当 JSON-RPC WebSocket。

外盘转账税及自动税款清算、未知工厂/Hook、Pons 救援或过渡阶段、没有原生币兑换路线、缺失 FX/Gas 样本或过期链头会阻断。
Pons V1 买入限制期内，缺少虚拟累计配额状态时拒绝买入。虚拟反向卖出不读取模拟地址真实余额。
Gap 事件只用于恢复；历史回放不输出新的 firstBuy 信号。firstBuy 表示本观察周期首次且前一区块余额为零，不宣称终身首次。
创建与买入同块时，前一区块不存在代币合约也可证明余额为零；其他历史读取失败不会被当成零。钱包信号必须有成功回执、同一日志/区块哈希、匹配协议代币净流和实际钱包净流；`payload.verified` 明确给出结果。
日志普通扫描是否回放按启动/恢复判断，不按快速链每秒产生的区块数判断。BSC/RH 最大缺口回放分别为64/256区块；真实缺口不会补造入场。撤销事件使用独立ID及原始 removedEventId；滞后的 HTTP 响应不触发伪重组。
Native/custom quote currencies 必须有已核实的转换池；缺失资产兑换或税费数据时拒绝，不假定股票/稳定币等于 1 美元。
跨报价币部分成交后的退款需考虑第一次兑换已改变的池状态；尚未逐步核实的此类复合退款会阻断，原生币原曲线的部分成交退款正常支持。
链上原始时间保存在 rawChainAt/rawCreatedAt；信号 at 按最新链头的实际年龄映射到本机接收时间，不改变系统时钟。市场 createdAt/scannerAt 属于固定创建/毕业时间，按首次可用真实链头映射并缓存原始时间身份，后续头的接收抖动不反复改写；仅原始时间修正或首次取得可用链时钟时重新映射。映射保存在 metadata.marketClock 并随目录持久化；缺少初始链时钟时创建时间为0、scannerAt省略，保留原始时间等待首个实际头。真实价格、updatedAt、FX 更新/过期及信号时限规则不变。恢复回放不作为新入场。
历史研究快照另保留原始 Gas 样本和当时 gasPrice；重报价会刷新核实区块哈希，拒绝重组与缺失历史 FX/Gas。普通 quote 不能用当前 FX 给超过2分钟的旧区块补价格。
旧费用快照若没有实际读取冻结时间会阻断，不能补造该字段。最近7个不同买入预算及即时反向报价的14次序列已测试，只读取一次 gasPrice，冻结样本不会被后续回执悄悄替换。
实链验收结果见 `fixtures/live-verification.json`，其中 blocked/缺样本不属于通过。
Flap 当实际流通量不足以卖出刚虚拟买入的数量时，同一区块同一 recipient 可取得虚拟买入后曲线的反向预览，明确标为 estimated，不能作为正式研究启用证据。跨区块未证明有可变现储备时仍可能卖不出。

已取得 Flap、Four、Pancake V2/V3、Pons V1/V2/V4 的全网关买入及反向报价；Flap 所用稀疏样本的反向为上述估计预览。另已通过真实行情的独立 Broker 虚拟买入/卖出往返与账本核对。60秒试跑不是24小时运行验收；首次钱包买入取决于观察期间是否有对应实际交易，不能从链头在线推断成功。
`fixtures/cache-quote-verification.json` 的0.90秒结果来自此前空闲、已预热的独立实例；它不是主服务满负载证明。当前队列补丁经过慢后台、并发上限、全局间隔、共享请求提升、队列超时、停止和前台 FX 不阻塞测试。完整软件负载下的两链买卖时延需由载入新构建的主服务验收，尚未据此宣称通过。
只通过运行中的主服务 `/api/paper/quote` 取得的 RH V1 DEX 样本见 `fixtures/rh-main-latency-before.json`：shrimothy 买入2869.7076ms，反向卖出1170.5107ms，均 verified，同区块81557930，共约4.04秒。该记录是最后路线缓存修复之前的真实主服务报价，未提交订单，不等于 Broker 延迟后成交及账本往返验收；其他 RH 候选的超时不能被这个成功样本抹去。
用户所选 BSC 0x4902c5ebc598265ed2212b559b042de8a5eeec3f 的主服务实际 K 线取证见 `fixtures/main-kline-verification.json`：返回100根，耗时2323.7271ms；未另启网关或绕过全局预算。该响应未提供新 source/pending 字段，不能据此声称新版缓存时延或浏览器可见性已验收。验证脚本 `--main-kline-qa` 只读取已有本机服务并保存公开结果。
