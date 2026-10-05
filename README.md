# Account Region Lab

**把每个账号的浏览器、线路和地区观察分开管理。**

Local browser profiles, proxy checks, device-review guidance, and country-association observations. Built for people managing their own accounts. **This is not a Google country changer, a residential proxy provider, or a stealth browser.**

[English guide](docs/README.en.md) · [调研依据](docs/research.md) · [fanout 接入](docs/fanout.md) · [验证范围](docs/verification.md) · [贡献指南](CONTRIBUTING.md)

## v0.2 能做什么

| 功能 | 实际行为 |
| --- | --- |
| 独立环境 | 每个环境使用独立持久浏览器目录，分隔 Cookie、站点存储和登录会话 |
| 固定线路 | 单独配置 HTTP / SOCKS5 代理，启动前核对国家；新环境默认首次校验并启动后绑定出口 IP |
| 设备退出助手 | 在该环境打开 Google 官方设备页，指导逐项退出其他会话，保存人工核查结果 |
| 两种浏览器模式 | 原生 Chrome / Edge 兼容模式；可设置语言、时区、视口和外观的 Playwright 受控实验模式 |
| 环境诊断 | 本地实测语言、时区、视口、UA、WebGL、权限等，与配置对照，支持 JSON 导出 |
| 同账号互斥 | 相同本地账号代号不能同时启动多个受控环境；不识别真实 Google 登录身份 |
| 公共节点发现 | 按需查询 VPN Gate 官方目录，显示来源和时间；所有节点标记“住宅属性未验证” |
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

启动成功后自动打开 <http://127.0.0.1:4317>。Windows 也可双击 `Start.cmd`，缺少依赖时会自动安装。**使用期间保留启动窗口；关闭它会停止本地服务，单独访问网址不会自动启动服务。** 再次启动会复用已运行的同一应用，不会重复占用端口。停止服务使用 `Ctrl+C`；受控浏览器随服务关闭，原生浏览器请自行关闭。需要仅运行服务而不打开浏览器时使用 `npm run serve`。

1. 编辑环境，填写自己的代理地址，例如 `socks5://127.0.0.1:1081`。示例端口不是附赠代理。
2. 可设置本地账号代号，如 `research-in`，不用提供 Gmail 地址或密码。
3. 先“检查网络”，再从环境卡片打开 Gmail、YouTube 或 Google 服务条款。
4. 在浏览器中自己登录，完成 Google 要求的验证。
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

代理必须带端口，不接受用户名密码 URL。带认证的上游可在你自己的本地客户端中转发成无凭证 SOCKS5 端点。项目不读取代理订阅密码，也不安装 VPN 客户端。

启动 Gmail / YouTube / 官方设备或地区页面前，程序通过对应代理请求 country.is。国家不符、请求失败，或启用严格绑定时 IP 变化，都会阻止这次启动。**这是启动时的检查，不是持续监控或网络断路器；已打开的浏览器仍可能继续使用变化后的线路。** country.is 与 Google 的地理数据库也可能不同。

公共目录只在你点击加载时读取 VPN Gate 官方来源，按国家筛选并缓存 120 秒。目录中的 VPN / OpenVPN 节点需要先用客户端或 fanout 转为 SOCKS5；不能把节点 IP 直接填成 HTTP 代理。志愿者节点不保证固定 IP、长久在线或住宅属性，不会自动替换你的账号线路。[fanout 接入及限制](docs/fanout.md)。

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

源码不包含登录会话。导出移除代理地址、检测 IP、绑定 IP 和账号代号，仍保留环境名称和人工备注，分享前应检查。浏览器目录包含敏感会话，**不要上传到 GitHub**。控制台只绑定本机，不适合多人共享或公网部署。[安全说明](SECURITY.md)。

## 验证与贡献

```bash
npm test
```

测试使用临时目录与模拟出口；真实本地诊断也已验证印度 / 尼日利亚参数。尚未验证真实账号改区、远程设备退出或 Google 登录成功率。[完整验证范围](docs/verification.md)。

如果这个工具有帮助，欢迎 Star、报告可复现问题或贡献代码。兼容性反馈、诊断改进、翻译和稳定的测试尤其有用。[CONTRIBUTING.md](CONTRIBUTING.md)

MIT 许可。感谢 [byJoey/fanout](https://github.com/byJoey/fanout) 提供的架构参考。公共目录解析器独立实现，未复制其代码。[第三方说明](THIRD_PARTY.md)
