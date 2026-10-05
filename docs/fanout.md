# 公共节点发现与 fanout 接入

Account Region Lab 的公共目录仅从 [VPN Gate 官方 CSV](https://www.vpngate.net/api/iphone/) 读取节点元数据，按国家筛选。界面中的速度、延迟和在线时间来自目录，未由本工具实测；“住宅属性未验证”表示我们没有证明运营商、住宅属性或当地长期归属。目录可能没有你需要的国家，条目也可能在显示后离线。

目录请求限时 15 秒，最多读取 2 MiB，缓存 120 秒；不跟随跳转、不访问任意订阅 URL、不返回 OpenVPN 配置及节点发布者留言。缓存过期后刷新失败会显示错误，不能把旧目录当作最新目录。发现节点不会自动连接代理、安装软件或登录账号。

## fanout 是什么

[byJoey/fanout](https://github.com/byJoey/fanout) 是将 VPN Gate OpenVPN 公共节点转换为 SOCKS5 出口的 Linux 工具，还能连接 3x-ui、xray-cf-lite 或自带 Xray。它需要 Linux 网络命名空间、OpenVPN 和相应管理权限。本项目独立实现目录读取，不包含或执行 fanout 安装脚本。

该项目使用 [MIT 许可](https://github.com/byJoey/fanout/blob/main/LICENSE)。它的住宅节点筛选主要排除已知 VPN Gate 自营节点特征，不能据此验证其余节点都是住宅出口。本项目因此统一标记“未验证”。

## 接入你已经部署的 SOCKS5 出口

1. 在你有权限使用的 Linux 主机上，按 fanout 自己的文档部署并核实出口。Account Region Lab 不负责安装或管理它。
2. 为每个账号分配一个明确的 HTTP 或 SOCKS5 端口。例如本机转发器提供 `socks5://127.0.0.1:1080`，或你受控远程主机提供 `socks5://你的主机:端口`。
3. 如果远程 SOCKS5 端口需要认证，使用你已有的本地代理客户端或安全隧道处理认证，再将本机无认证端口填入环境。不要把远程代理端口无认证地暴露到公网。
4. 在环境中填入该出口，运行“检查网络”，确认出口国家与环境目标一致，再打开浏览器。目录中的 VPN Gate IP 是 VPN 服务器元数据，不能直接粘贴为浏览器代理。

fanout 的 `/sub?token=…` 订阅提供 VLESS、VMess、Trojan 等 Xray 入站链接，默认是整体 base64 编码，也可选择明文链接。它不是 HTTP / SOCKS5 地址列表。先使用你已有且信任的客户端导入，并映射为本地 HTTP / SOCKS5，再接入环境；不要将订阅 token 粘贴到公开截图、Issue、日志或分享文件。

## 对账号地区观察的限制

fanout 的公共节点可因离线、负载等原因自动重连或换节点，这会改变出口 IP。[VPN Gate 官方概述](https://www.vpngate.net/en/about_overview.aspx) 也说明志愿者节点和 IP 地址会动态变化。这类出口无法保证固定住宅 IP，更不能保证 Google 账号关联国家改变；要观察同一账号的长期地区，优先使用你能够管理的稳定出口，并持续记录出口变化。

[VPN Gate 官方反滥用说明](https://www.vpngate.net/en/about_abuse.aspx) 说明其集中连接日志至少保存三个月，志愿者服务器的包头日志至少保存两周。公共节点由他人运营，选择连接前应查看服务说明。fanout README 还说明其域名解析在宿主机完成；独立浏览器配置并不自动修复上游客户端的 DNS 路由。

以上外部项目和服务说明核验于 **2026-10-05**。可用国家和节点数量不断变化，以界面每次成功获取目录的时间为准。
