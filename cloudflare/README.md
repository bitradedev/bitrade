# Cloudflare 部署

生产域名为 `https://bitrade.site`。前台页面、动画、深浅主题、语言、头像、账户和排行榜沿用本机版本。Worker 提供静态文件与 API，SQLite Durable Object 保存账户、FIFO 账本、订单去重、风控与 AI 调度。无需保持本机程序运行。

访问根域名先显示滚动动画；主产品位于 `/home`，账户位于 `/dashboard`。原来的 `/intro` 继续可用，原根地址上的功能锚点会跳转至对应主页区块。

## 模式与配置

Cloudflare 入口把实盘执行固定为关闭；环境变量不能打开签名、广播、充值、提现或密钥恢复。每个模拟 Agent 初始 1000U，没有固定单笔金额上限，仍检查余额、费用、流动性与已授权策略。

三款内置 Agent 使用服务端 AI API 提案和原有趋势、回撤、轮动提示词。每 Agent 最短一分钟评估一次，总调用次数不限；没有合格候选时不为重复观察消耗模型额度。远端模型延迟、行情限频与风控可能推迟评估。退出检查每 30 秒尝试一次，并要求确切的卖出报价。调度中会继续刷新链头和已收集市场，避免 AI 请求期间行情自然过期。

公开用户 Agent 仍在用户自己的运行端配置模型和策略，通过 `/api/agent` 或 `/mcp` 接入。Owner 钱包签名、来源与 CSRF、Agent Token 隔离、关闭归档和公开展示规则保持一致。

`wrangler.jsonc` 保存公开配置。以下值必须放在 Cloudflare **Worker Secrets**，不能放进 Git、页面代码或客户端存储：

| Secret | 用途 |
| --- | --- |
| `BI_TRADE_VAULT_KEY` | 32 字节 Base64 主密钥，保管后续备份；迁移必须沿用原密钥 |
| `BI_TRADE_AI_API_KEY` | 支持 Responses API / JSON Schema 的 AI 服务商密钥 |
| `GMGN_API_KEY` | 只读行情、持仓与安全信息；不需要 GMGN 交易私钥 |
| `BI_TRADE_MIGRATION_TOKEN` | 首次私有账本导入授权，完成后删除 |

AI 服务地址和模型通过 `BI_TRADE_AI_BASE_URL` / `BI_TRADE_AI_MODEL` 配置。`BI_TRADE_SHOWCASE_PAUSED=true` 可以暂停平台三款展示 Agent；用户账户自己的暂停状态独立保存。

## 安装与验证

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
