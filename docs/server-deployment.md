# 海外服务器部署

服务器模式把工作台、浏览器和代理连接都放在服务器上。本地电脑用浏览器访问工作台，再通过“服务器桌面”操作服务器上的 Chrome，手动完成 Google 登录。本机无需运行本项目或为服务器浏览器配置本机代理；本地网络仍须能访问服务器的 HTTPS 地址。

这套部署面向一位使用者。配置、Chrome 用户目录和登录会话保存在服务器磁盘上，每个环境使用独立 UUID 目录。最多同时运行 5 个环境，每个环境独占 Xvfb、窗口管理器、VNC/noVNC 和 Chrome 进程。设置 `REGION_LAB_MAX_ENVIRONMENTS=1` 到 `5` 可降低上限。1 GB 主机运行多个大型页面可能明显变慢，功能上限不等于承载能力。所有环境仍由同一个系统用户运行，不是虚拟机或多人安全隔离平台。

首版 noVNC 提供画面和键鼠，不传输浏览器音频，不承诺流畅高清视频。原生浏览器的时区仍取服务器系统值，环境里的时区是诊断目标；不会伪造指纹或生成浏览行为。

小内存服务器可按[性能说明](performance.md)启用轻量模式、1024×768 桌面和 Chrome 后台任务策略。DAMAGE 默认开启；若某台 X server 有局部刷新兼容问题，可设置 `REGION_LAB_X11VNC_DAMAGE=0` 回退全屏轮询。画面收起与关闭浏览器是两种操作，只有后者会释放该环境的 Chrome 内存。

## 访问链路

```text
本地浏览器
  └─ HTTPS :443 → nginx
       └─ 127.0.0.1:4318 → 身份验证网关
            ├─ 工作台 → 127.0.0.1:4317
            └─ /desktop/<环境 UUID>/<本次运行标识>/
                 └─ 127.0.0.1:6101..6105 (独立 noVNC / WebSocket)
                      └─ 127.0.0.1:5902..5906 (独立 x11vnc)
                           └─ Xvfb :200..:204 → 对应环境的 Chrome

服务器 Chrome → 该账号配置的目标地区代理 → Google
```

`4317`、`4318`、`6101..6105` 和 `5902..5906` 都必须只监听服务器回环地址。桌面端口按需启动，关闭环境后回收。nginx 只能转发到身份验证网关，不能添加绕过网关的工作台或桌面转发规则。x11vnc 使用 `-nopw`，因为此内部端点依赖回环监听和外层网关验证；切勿把 VNC 或 noVNC 端口映射到公网。HTTP 与桌面 WebSocket 都需经过网关验证。旧的环境画面 URL 在环境重开后失效，不能因端口被复用而进入另一个环境。

海外服务器解决的是连接发起位置。账号出口仍由所选代理决定；免费节点的寿命、速度和住宅属性不会因此改善，也不能保证 Google 的地区关联发生变化。七天是本工具的观察周期。

## 固定目录与组件

模板面向 Ubuntu 24.04，采用独立的非 root 用户 `regionlab`：

| 路径 | 用途 | 所有者 / 权限 |
| --- | --- | --- |
| `/opt/account-region-lab/app` | 本仓库及生产依赖 | root 所有，服务用户只读 |
| `/opt/account-region-lab/node` | 独立 Node.js 24 运行时 | root 所有，服务用户只读 |
| `/var/lib/account-region-lab` | 服务用户主目录和网关访问文件 | `regionlab`，0700 |
| `/var/lib/account-region-lab/data` | 环境记录、浏览器目录和认证密钥 | `regionlab`，0700 |
| `/var/lib/account-region-lab/access.json` | 网关用户名、随机盐和密码哈希 | `regionlab`，0600 |
| `/etc/account-region-lab.env` | 外部 HTTPS 地址、Chrome 路径 | `root:regionlab`，0640 |
| `/run/account-region-lab` | systemd 创建的临时 X11 认证目录 | `regionlab`，0700 |

基础组件包括 `xvfb`、`xauth`、`x11-utils`、`openbox`、`x11vnc`、`novnc`、`websockify`、`python3`、`curl`、`nginx`、CA 证书以及中文/emoji 字体。`mcookie` 来自 util-linux。安装官方 Google Chrome，并确认 `BROWSER_PATH` 指向其可执行文件。

Chrome 必须由 `regionlab` 运行并保留浏览器沙箱。不要添加 `--no-sandbox`，也不要以 root 身份启动 Chrome。Ubuntu 24.04 的用户命名空间限制可能影响浏览器沙箱；应使用官方 Chrome 包及与其可执行路径匹配的 AppArmor 配置。若出现 sandbox / userns 拒绝，检查系统日志和 Chrome 安装配置，不要通过全局关闭 AppArmor 或禁用沙箱绕过。

## 安装模板

以下步骤需要部署者已有服务器管理权限。TLS 证书、DNS、防火墙及 nginx 主机配置由部署者单独准备；仓库模板不会修改其他网站。

1. 创建 `regionlab` 系统用户，并建立上表目录。该用户不需要可交互的 SSH 登录 shell。把仓库复制到 `/opt/account-region-lab/app`，把经校验的 Node.js 24 安装到 `/opt/account-region-lab/node`。安装生产依赖时使用这一运行时，避免替换其他项目使用的系统 Node。
2. 将 `deploy/linux/account-region-lab.env.example` 复制为 `/etc/account-region-lab.env`，填写精确的外部 HTTPS origin，例如 `https://lab.example.com`。值不含路径或末尾斜杠。设置 `root:regionlab` 所有权和 0640 权限。不要在共享环境文件中设置 `PORT`；工作台与网关分别使用 4317 和 4318。
3. 创建访问密码文件。以下命令会遮蔽终端中的密码输入，默认用户名为 `admin`。密码至少 16 个字符，不能作为命令行参数传递：

   ```bash
   sudo -u regionlab /opt/account-region-lab/node/bin/node \
     /opt/account-region-lab/app/deploy/linux/create-access.mjs
   ```

   脚本仅在文件不存在时创建 `access.json`，不会覆盖已有账户；密码只用于计算带随机盐的 scrypt 哈希。自动化部署可通过标准输入提供一行密码，避免写入 shell 历史、进程参数或日志。需要重置时，应由部署者先停止网关、备份访问文件，再显式更换文件并重启。
4. 安装两个 unit：

   ```bash
   sudo install -m 0644 /opt/account-region-lab/app/deploy/linux/account-region-lab.service /etc/systemd/system/
   sudo install -m 0644 /opt/account-region-lab/app/deploy/linux/account-region-lab-gateway.service /etc/systemd/system/
   sudo systemd-analyze verify /etc/systemd/system/account-region-lab.service /etc/systemd/system/account-region-lab-gateway.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now account-region-lab.service account-region-lab-gateway.service
   ```

   控制器按环境启动桌面脚本，使用各自私有 Xauthority，禁止 X11 TCP 监听。noVNC 与 VNC 准备好后再打开 Chrome；任意桌面组件退出会关闭该环境并回收资源，不影响其他环境。关闭浏览器后保留用户目录，重新打开须由用户操作。

   从 v0.4 升级时先关闭正在运行的环境，停止工作台和网关，再执行 `sudo systemctl disable --now account-region-lab-desktop.service`。旧的共享桌面不再使用；安装新 unit 后执行 daemon-reload 并启动两个服务。不要同时启用旧桌面 unit。升级前备份数据及配置。
5. 将 nginx 的 HTTPS 主机转发到 `http://127.0.0.1:4318`。保留真实 `Host`，设置 `X-Forwarded-Proto: https` 和正确的客户端来源信息；为 WebSocket 转发 `Upgrade`/`Connection`，使用 HTTP/1.1，并给予桌面连接足够的读取超时。公网只开放所需的 HTTPS 和受限的管理入口。先执行 `nginx -t`，再重载 nginx。

## 首次验收

部署成功不能只以端口监听或首页打开为准，应完成以下实际流程：

1. 查看两个 systemd 服务状态；使用 `ss -ltnp` 确认内部端口没有绑定 `0.0.0.0` 或公网地址。
2. 在未登录的本地浏览器中打开外部 HTTPS 地址，确认先看到身份验证；工作台 API 和 `/desktop/` 不能绕过验证。登出后重新访问也需验证。
3. 打开两个测试环境的诊断页，分别进入画面或独立窗口，确认画面不同、鼠标键盘只影响选中环境。切换画面、关闭一个窗口或一个环境后，另一个环境应保持运行。
4. 在工作台配置一个可用的目标地区代理，先检测出口与 Google 目标页面，再打开 Google 登录页。Chrome 应出现在服务器桌面内；它不会在本机任务栏创建窗口。
5. 手动完成登录后关闭该账号浏览器并重新打开同一环境，核对是否保留预期会话。浏览器登录能否持续取决于 Google 的会话规则；工具不会自行认定登录成功。
6. 重启整套服务，检查工作台、桌面和相同 UUID 的浏览器目录是否恢复。登录启动或 systemd 启用并不等于已经验证过整机重启。

常用诊断命令：

```bash
sudo systemctl status account-region-lab account-region-lab-gateway --no-pager
sudo journalctl -u account-region-lab -u account-region-lab-gateway -n 100 --no-pager
sudo ss -ltnp
sudo systemctl restart account-region-lab.service
```

日志可能含远程访问记录。公开问题或日志前，应移除账号信息、IP、URL 中的私人内容和认证材料。

## 持久化与备份

Linux 服务器模式使用 AES-256-GCM 保存代理认证，安装密钥保存在数据目录中的私有文件，要求服务用户所有、0600 权限，并拒绝符号链接。该密钥只保护代理认证存储；Chrome 用户目录仍包含敏感账号会话，应保护整个数据目录。

备份时先停止工作台和桌面，完整备份 `/var/lib/account-region-lab` 及部署配置，再恢复服务。代理密文必须与原安装密钥一起保留：缺失或更换密钥后不能解密原认证。不要把密钥、`access.json`、Chrome 用户目录或完整数据备份提交到 GitHub。恢复后保持用户所有权和权限，使用原环境 UUID 目录。

Windows DPAPI 认证不能直接由 Linux AES 密钥解密。迁移 Windows 环境时应在服务器重新填写代理认证；不要假设复制 Windows 的 Chrome 用户目录就能迁移其所有登录会话。
