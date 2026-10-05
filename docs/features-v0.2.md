# v0.2：功能依据与边界

核查日期：2026-10-05。

## Google 设备退出

[Google 官方设备帮助](https://support.google.com/accounts/answer/3067630?hl=en) 说明在“管理所有设备”中选择设备或会话，再退出；同设备下多个会话可能需要分别处理。[Gmail 退出帮助](https://support.google.com/mail/answer/8154?hl=en) 同样引导到设备管理。[最近账号活动](https://support.google.com/mail/answer/45938?hl=en) 可查看访问情况，不能据此假定存在稳定的全设备退出接口。

[Directory users.signOut](https://developers.google.com/workspace/admin/directory/reference/rest/v1/users/signOut) 属于 Google Workspace 管理员 API。没有找到适用于普通 `@gmail.com`、保留当前会话并一次退出全部其他设备的公开 API。v0.2 使用官方页面加人工核查记录，不收集凭证，未实施未经验证的自动点击批处理。

## 环境隔离

[Playwright persistent context](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context) 支持独立目录、proxy、locale、timezoneId、viewport、colorScheme。受控模式使用这些正式接口，保留自动化标志。

[Chrome WebRTC 隐私 API](https://developer.chrome.com/docs/extensions/reference/api/privacy) 包括 `disable_non_proxied_udp`。这不等于完全禁用 WebRTC，项目也未做持续网络泄漏测试。

[AdsPower 功能说明](https://help.adspower.com/docs/browser_fingerprint) 列出多项浏览器指纹维度。v0.2 参考环境参数配置与诊断的产品方式，不宣称具备同等完整指纹能力，不修改 Canvas、字体或硬件特征，不保证账号不可被关联。

## OpenAI 开源维护者计划

[Codex for Open Source 官方说明](https://developers.openai.com/community/codex-for-oss) 在核查时列出：符合条件维护者可申请六个月 ChatGPT Pro with Codex、按条件审核的 Codex Security，以及开源维护工作所需的 API credits。

官方邀请核心维护者、广泛使用的公共项目申请，也允许说明项目对生态的重要作用。该说明未给出“固定 Star 数自动兑换”的规则。公开源码、完善文档、接受真实反馈，有助于形成维护记录，但不保证获批；刚发布的原型不能冒称已有广泛用户。

本项目没有提交申请、接受申请条款、虚报影响力、购买 Star 或许诺会员奖励。申请须由维护者按当时要求和真实项目情况提交。
