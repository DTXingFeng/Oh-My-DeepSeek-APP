# 免费 App 限制与官方 API 边界

核查日期：2026-11-17（香港时间）。

11 月 16 日[澎湃新闻的报道](https://www.thepaper.cn/newsDetail_forward_34490312)记录了用户反馈：每日额度受限、单次输入缩短至约 4 万字、超过 7 天不活跃的长对话无法继续。报道指出未有统一公布的规则，不能据此认定每个账号都有相同的具体限额。当天[第一财经报道](https://www.cnfin.com/gs-lb/detail/20261116/4496316_1.html)也记录了上述变化。这些是报道和用户反馈，不是本项目在官方 App 内触发限额的实测。

本项目调用付费官方开发者 API，不登录或调用免费 App 的私有聊天接口。

| 项目 | Oh My DeepSeek 的行为 | 仍然存在的边界 |
| --- | --- | --- |
| 每日聊天额度 | 客户端不累计或限制日使用量 | API 余额、账户限制、服务可用性 |
| 约 4 万字输入 | 文本输入组件不设这个字符上限 | 请求上下文上限、设备内存；超出时展示 API 错误 |
| 七天不活跃会话 | 本机保存全部历史，发送时重建上下文，不按会话年龄禁用 | API 上下文仍有限；卸载或清除应用数据会删除本地记录 |
| 附件 | 文件选择器交给系统，保留官方示例的 API 校验 | 普通文件 64 MiB，user_data 文件 32 MiB；每轮客户端最多 50 个附件 |
| 语音 | 支持麦克风权限、录音、ASR 和朗读接口 | 录音单次 120 秒，与现有 ASR 客户端实现一致 |
| 模型输出 | 按服务返回内容展示、支持继续生成 | 模型能力、服务端安全与输出长度规则 |

截至核查时，官方[模型文档](https://api-docs.deepseek.com/quick_start/pricing/)列出 Flash / Pro 的上下文为 1M token，最大输出为 384K token；并发为账户级限制，参见[并发文档](https://api-docs.deepseek.com/quick_start/rate_limit/)。这不是无限上下文，也不等于任何输入都能一次成功。

官方于 11 月 13 日发布[完整应用 API 公告](https://api-docs.deepseek.com/news/news261113/)，并提供 MIT 开源的 [chat-demo](https://github.com/deepseek-ai/chat-demo)。搜索、文件解析、ASR、TTS 等除模型 token 之外还可能产生工具费用，当前费用以[官方价目表](https://api-docs.deepseek.com/quick_start/pricing/)为准。
