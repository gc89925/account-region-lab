# Account Region Lab

**把每个账号的浏览器、线路和地区观察分开管理。**

Local browser profiles, proxy checks, device-review guidance, and country-association observations. Built for people managing their own accounts. **This is not a Google country changer, a residential proxy provider, or a stealth browser.**

[English guide](docs/README.en.md) · [调研依据](docs/research.md) · [fanout 接入](docs/fanout.md) · [验证范围](docs/verification.md) · [贡献指南](CONTRIBUTING.md)

## v0.3 能做什么

| 功能 | 实际行为 |
| --- | --- |
| 独立环境 | 每个环境使用独立持久浏览器目录，分隔 Cookie、站点存储和登录会话 |
| 固定线路 | 单独配置 HTTP / SOCKS5 代理，启动前核对国家和所选 Google 页面连通性；新环境默认首次校验并启动后绑定出口 IP |
| 设备退出助手 | 在该环境打开 Google 官方设备页，指导逐项退出其他会话，保存人工核查结果 |
| 两种浏览器模式 | 原生 Chrome / Edge 兼容模式；可设置语言、时区、视口和外观的 Playwright 受控实验模式 |
| 环境诊断 | 本地实测语言、时区、视口、UA、WebGL、权限等，与配置对照，支持 JSON 导出 |
| 同账号互斥 | 相同本地账号代号不能同时启动多个受控环境；不识别真实 Google 登录身份 |
| 代理认证与诊断 | Windows 加密保存 SOCKS5 用户名密码，经本机转发用于原生浏览器；区分认证、协议、目标站点、DNS 和超时错误 |
| 免费代理筛选 | 分批自动检测美、日、韩候选，显示进度、取消和失败原因，默认仅显示两分钟内通过国家与 Google HTTPS 检查的节点；住宅属性未验证 |
| VPN Gate 目录 | 作为备选源显示志愿者 VPN 目录和官网连接配置入口，需要独立客户端转发 |
| 观察记录 | 七天复查周期、手工记录 Google 条款页国家、设备核查和脱敏导出 |

默认提供印度 `IN` 和尼日利亚 `NG` 环境。目标国家是你的配置，**不代表 Google 已把账号归属到那里**。

## 快速开始

需要 Node.js **24**、`curl` 和已安装的 Chrome 或 Edge。受控模式复用本机浏览器，不下载额外 Chromium。

```bash
git clone https://github.com/gc89925/account-region-lab.git
cd account-region-lab
npm ci --ignore-scripts
npm start
```

启动成功后自动打开 <http://127.0.0.1:4317>。Windows 也可双击 `Start.cmd`，缺少依赖时会自动安装。**服务默认后台运行，启动窗口可以关闭。** 再次启动会复用同一数据目录的应用；其他目录占用端口会明确报错。使用 `Stop.cmd` / `npm stop` 停止，`Status.cmd` / `npm run status` 查看状态和日志路径。需要终端前台模式时使用 `npm run serve`。

希望重启电脑后恢复服务，可主动运行 `Enable-Login-Startup.cmd`：为当前用户注册 Windows 登录计划任务，不提升管理员权限；异常退出时最多重试 3 次，间隔 1 分钟。用 `Disable-Login-Startup.cmd` 撤销。该选项不会在下载项目时自动安装。停用登录启动不停止当前服务，停止服务也不会移除下一次登录的启动项。

`launcher.local.json` 可指定 `{ "dataDir": "源码之外的数据目录", "port": 4317 }`，被 Git 忽略。Start、Stop、登录任务使用同一配置；环境变量可覆盖。日志位于数据目录的 `logs/service.log`。项目移动位置后需重新安装登录启动项。

1. 编辑环境，填写自己的代理地址，例如 `socks5://127.0.0.1:1081`。有认证的 SOCKS5 代理另填代理用户名和密码，点击“诊断代理”检查认证、实际国家及 Google 连通性。示例端口不是附赠代理。
2. 可设置本地账号代号，如 `research-in`，不用提供 Gmail 地址或密码。
3. 点击环境卡片的“登录 Google 账号”。尚未配置代理时会直接引导你填写；配置后会检查出口，再打开这个环境专属的 Chrome / Edge 窗口。
4. 切换到弹出的独立浏览器，在 Google 官方页面中自己登录，完成 Google 要求的验证。Google 密码不在工作台填写。之后从同一张环境卡片打开 Gmail、YouTube 或服务条款，会继续使用该环境保存的会话。
5. 使用“检查 / 退出其他设备”，确认正确账号后，在 Google 页面逐项退出不再使用的会话。
6. 在条款页核对实际关联国家，回到工作台记录。七天后复查实际变化。

## 浏览器隔离与诊断

| 项目 | 原生兼容模式 | 受控实验模式 |
| --- | --- | --- |
| 独立 Cookie / 存储目录、显式代理 | 支持 | 支持 |
| 语言、窗口 | 请求启动参数，效果需诊断 | 应用 locale / viewport |
| 时区 | 仅作诊断目标，保留系统时区 | 应用 timezoneId |
| 外观 | 保留浏览器行为 | light / dark / system |
| 工作台关闭、运行状态 | 无法可靠跟踪，请手动关闭 | 可关闭并释放本应用互斥 |
| 自动化可见性 | 不额外接管 | Playwright，**不隐藏 webdriver** |

受控模式可能遇到 Google 登录兼容性限制。普通 Profile 不是虚拟机，也不隔离硬件、系统字体或完整设备指纹。项目不伪造 Canvas / WebGL，不随机冒充其他操作系统，不生成观看行为。

“环境诊断”打开本地 `file:` 页面，无外部资源、遥测或 STUN 请求。它展示配置与实测差异，不验证 IP、DNS 或 WebRTC 是否完全无泄漏。页面显示的权限只属于该诊断来源；程序不主动授予地理定位、摄像头或麦克风权限。受控模式下载路径独立，但 Playwright 在关闭 context 时可能清理下载，请及时保存需要保留的文件。

首次打开浏览器（包括诊断页）后，国家、代理及环境参数固定，避免复用旧进程时设置不一致。换线路地址或环境参数请新建环境。仅诊断不会绑定出口 IP，也不开始观察周期。诊断仍要求先填写代理，防止把一个直连运行的环境随后当作代理环境使用。

## 代理、固定 IP 与公共目录

```text
http://127.0.0.1:18081
socks5://127.0.0.1:18082
```

代理必须带端口。可在代理地址框粘贴 `socks5://用户名:密码@主机:端口`，程序立即拆分到地址、用户名和隐藏密码框，并支持 URL 百分号编码；完整认证链接不会留在地址栏、日志或导出记录中。也可在独立字段输入认证。Windows 使用当前用户的 DPAPI 加密保存，状态接口、导出和浏览器命令行不包含密码。浏览器连接仅监听 `127.0.0.1` 的转发端口，由转发器向配置的上游完成认证。重启服务时恢复同一环境的本地转发端口；停止服务会中断依赖它的浏览器连接。HTTP 认证及其他系统暂需在本地客户端配置认证。项目不读取代理订阅密码，也不安装 VPN 客户端。

编辑、观察记录和设备核查弹窗不会因点击外侧页面而关闭；请使用明确的取消、关闭按钮或 Esc 退出。

启动 Gmail / YouTube / 官方设备或地区页面前，程序通过对应代理请求 country.is；检测站点失败时有限次尝试 ipwho.is，认证和端口连接错误不重试其他站点。出口检查通过后，再通过同一代理 GET 请求本次所选的 Google 目标 URL，失败时留在工作台显示原因，不再启动新窗口。“检查网络”同时检测 Google 登录入口。国家不符、请求失败，或启用严格绑定时 IP 变化，都会阻止这次启动。**这是启动时的检查，不是持续监控或网络断路器；已打开的浏览器仍可能继续使用变化后的线路。** HTTPS 检查不跟随重定向，2xx/3xx 只证明该 URL 当时可达，不证明后续页面、资源或 Google 登录成功。检测站点与 Google 的地理数据库也可能不同。“诊断代理”只在协议不明确时测试另一协议，需用户明确应用建议，不自动修改或直连。

没有代理时，点击“自动筛选可用节点”：每批最多 30 个、同时最多 3 个请求，按国家轮转，重复筛选推进后续候选。默认只展示两分钟内通过出口国家及 Google HTTPS 检查的结果；可展开全部候选查看失败原因，或停止后续排队。没有通过时会明确显示零个通过，不代表目录下载失败。来源数量不等于可用数量；Google 入口可达不代表已登录或账号验证会通过。每国最多展示 100 个候选，目录缓存 120 秒。全部候选的住宅属性均未验证，ASN 信息也不等同于家宽证明。

VPN Gate 是另一个目录选项，支持全部国家，并提供从官网当前列表取得的连接配置页面。目标国家没有节点会明确显示零；下载失败单独报错。其 VPN / OpenVPN 节点需要先用客户端或 fanout 转为 SOCKS5；不能把节点 IP 直接填成 HTTP 代理。目录不保证固定 IP 或长久在线，不会自动替换你的账号线路。[fanout 接入及限制](docs/fanout.md)。

## 设备退出不是一键全设备 API

个人 Gmail 的官方流程是“管理所有设备 → 选择设备 / 会话 → 退出”，同一设备可能有多个会话。工作台只是打开相应页面，并记录你的核查说明；不会读取密码、调用未公开退出接口或把打开页面记作退出成功。

Google Workspace 管理员的 `users.signOut` API 不等于普通 Gmail 能力。退出其他会话不代表抹掉过去的活动记录，不能据此承诺改变 Google 关联国家。[官方流程与边界](docs/features-v0.2.md)。

## 数据与升级

数据默认在源码之外：Windows `%LOCALAPPDATA%\AccountRegionLab`；macOS `~/Library/Application Support/AccountRegionLab`；Linux `$XDG_DATA_HOME/AccountRegionLab` 或 `~/.local/share/AccountRegionLab`。

| 环境变量 | 用途 |
| --- | --- |
| `REGION_LAB_DATA_DIR` | 数据目录，使用源码之外的绝对路径 |
| `BROWSER_PATH` | Chrome / Edge 可执行文件绝对路径 |
| `PORT` | 本地端口，默认 `4317` |

v0.1 数据自动补齐新字段，原有记录不清空。旧环境保留原生模式和原来的按国家校验，不会自动开启严格 IP 绑定；新环境默认开启。修改旧环境前先备份数据并关闭相应浏览器。

源码不包含登录会话。导出移除代理地址、认证密文、代理用户名、检测 IP、绑定 IP 和账号代号，仍保留环境名称和人工备注，分享前应检查。加密认证绑定当前 Windows 用户，复制到其他用户或电脑后需重新输入。浏览器目录包含敏感会话，**不要上传到 GitHub**。控制台只绑定本机，不适合多人共享或公网部署。[安全说明](SECURITY.md)。

## 验证与贡献

```bash
npm test
```

测试使用临时目录与模拟出口；真实本地诊断也已验证印度 / 尼日利亚参数。尚未验证真实账号改区、远程设备退出或 Google 登录成功率。[完整验证范围](docs/verification.md)。

如果这个工具有帮助，欢迎 Star、报告可复现问题或贡献代码。兼容性反馈、诊断改进、翻译和稳定的测试尤其有用。[CONTRIBUTING.md](CONTRIBUTING.md)

MIT 许可。感谢 [byJoey/fanout](https://github.com/byJoey/fanout) 提供的架构参考。公共目录解析器独立实现，未复制其代码。[第三方说明](THIRD_PARTY.md)
