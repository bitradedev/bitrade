# dotstrade → bi trade 核心功能核对

参考公开来源：

- https://www.dotstrade.fun/
- https://www.dotstrade.fun/docs
- https://www.dotstrade.fun/api/agent
- https://www.dotstrade.fun/agents.md

未登录参考站的Owner仪表板，无法确认其受保护页面的逐像素细节；这里按公开文档实现等价功能，不声称获得其私有源码或内部收益算法。保留bi trade品牌，仅构建BSC56。

| 参考核心 | BSC版本实现 | 当前验证 |
| --- | --- | --- |
| 首页导航、四个Agent角色、三步入门 | 独立新首页、原创向量角色、账户/配对/控制三步 | 桌面和移动端浏览器 |
| EVM钱包登录 | 一次nonce、用途与域名绑定、5分钟、链56、HttpOnly24h | 真实签名本地验证；未代用户登录 |
| 永久Agent钱包 | 固定ID/address、AES-GCM加密私钥 | 重连保留钱包与原资本 |
| 一次配对链接 | Owner绑定、15分钟、哈希存储、一次消费 | API与浏览器 |
| Agent重连 | 仅换token并撤销旧token | 测试通过 |
| 余额模式/受限策略 | Owner签名白名单、预算、Gas、期限；禁止受限通用调用 | 模拟与实盘假RPC |
| 暂停 | 拒绝新单、取消待模拟、保留待实盘核对 | 测试通过 |
| 充值、提现、恢复 | 钱包充值、Owner签名提现固定收款人、一次恢复并暂停 | 代码与假RPC完成；真钱锁定 |
| register_dot/get_account/buy_token/submit_transaction/get_trade | 同名直接API、Agent作用域 | 测试通过 |
| MCP工具 | initialize/list/call/ping，JSON Streamable HTTP | 测试通过 |
| 路线与执行 | Pancake V2/V3直接WBNB买入，自建实盘调用 | ABI/地址核对；无真钱广播 |
| 幂等、单待单、原签名重发 | 稳定requestKey，签名先落库，同nonce同字节 | 重启假RPC测试 |
| 公开钱包与交易分页 | Owner主动公开、模式/Agent筛选、20条分页、15秒刷新 | 隔离与筛选测试 |
| 已实现盈亏、开放持仓、回执 | BNB FIFO、Gas、未知成本不填数字、BscScan链接 | 算账与确认测试 |
| Token合约复制/市场数据 | 可配置CA，DexScreener市场；未发行显示待发布 | CA未配置，价格/持有人不虚构 |
| 文档/策略手册/FAQ | 中文使用文档、机器文档、12个研究方向 | 路由与浏览器 |

保留此前确定的模拟模式：每Agent1000U、单笔无固定上限，金额和费用须在可用余额内。实盘钱包初始为空，资金系统与虚拟账本分开。不能把关闭真钱理解成尚未开发实盘，也不能把假RPC验证说成真钱成交验证。

没有塞入旧六模块研究看板、Robinhood公共账户或自动默认策略。旧研究服务与历史账本保留。BI合约尚未发行，持有人统计尚未接入；平台不收取未经定义的BI税费，也不抄入DOTS合约或钱包。
