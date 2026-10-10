# 独立只读行情中继

供获准访问 GMGN 的固定 IPv4 服务器运行。网站界面、账户账本、AI 调度继续在 Cloudflare；中继只访问 BSC token info、security、top holders 和 trenches。没有买卖、钱包、签名、提现接口，不需要任何交易私钥。它是可选接入方案，**仓库中代码已准备，但没有服务器地址及中继授权时不会启用**。

[Cloudflare 跨站请求会使用共享 Worker 客户端地址](https://developers.cloudflare.com/fundamentals/reference/http-headers/)，GMGN 的 SDK 文档也提示 IPv4 兼容要求；这构成访问兼容性风险，不能单凭 429 断定就是原因。开启中继前应核对 GMGN 套餐、同密钥其他使用端和获准的出口配置。中继不会轮换 IP、绕过 API-key 配额或重试封禁请求，仍把 GMGN 的限频状态原样传回 Worker。

部署需要一台已有固定公网 IPv4 的 Linux 服务器、域名子域名及 Docker Compose。先把 `market.bitrade.site` 的 DNS 指向服务器，准备服务器本地 `.env`：`GMGN_API_KEY`、随机至少 43 字符的 `GMGN_RELAY_TOKEN`、`MARKET_RELAY_HOST`。密钥只配置在服务器和 Cloudflare Secret，不能提交 Git 或发到聊天。执行 `docker compose -f compose.yml up -d --build`，验证 HTTPS `/health` 与拒绝未授权访问。

然后设置 Cloudflare 公开变量 `GMGN_RELAY_URL=https://market.bitrade.site` 和 Secret `GMGN_RELAY_TOKEN`。Worker 不向中继发送 GMGN 密钥，密钥由中继本地保存；中继不转发客户端 IP、Cookie 或签名。上游地址固定为官方 GMGN，HTTPS 校验证书、强制 IPv4，禁止跳转，接口白名单与参数校验阻止它成为任意代理。主平台的全局串行队列、持久化缓存和冷却规则保持有效，中继的请求间隔至少 3 秒。

配置完整时采用中继；中继出错不会自动切回另一出口重复请求。清除这两个配置即可恢复原来的 Cloudflare 直连。配置切换不删除或修改用户账本。上线后的 `/api/runtime` 将显示 `marketTransport: private-relay`，但只有候选币、风控与真实模拟成交全部核实后才能称为运行恢复。
