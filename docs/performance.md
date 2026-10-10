# 小内存服务器运行建议

环境数量不等于页面数量。每个环境有独立 Chrome、账号资料目录、代理和桌面；环境内仍可能打开多个页面。旧版每点一次登录、Gmail、YouTube 或诊断都会强制新增窗口，多个窗口的当前标签也会同时占用资源。

现在首次启动仍创建窗口，环境运行期间点击快捷入口会在已有浏览器中打开新标签，不再强制新增窗口。这不会复用或自动关闭已有标签。已经打开的旧窗口也不会自动合并；可以手动关闭不用的页面，或者保存当前操作后关闭环境再重新打开。账号资料目录会保留。

服务器设置 `REGION_LAB_RESOURCE_MODE=lean` 后，Chrome 初始窗口大小还会限制在远程桌面范围内。默认范围为 `1024x768`，可用 `REGION_LAB_DESKTOP_GEOMETRY` 指定；环境中已配置的更小窗口不会被放大，保存的环境尺寸也不会被改写。标准模式继续使用环境原有的窗口尺寸。

## 可选的 Chrome 内存策略

`deploy/linux/chrome-low-memory.json` 使用 Chrome 官方策略：

| 策略 | 设置 | 效果 |
| --- | --- | --- |
| `HighEfficiencyModeEnabled` | `false` | 默认关闭主动回收后台标签，避免小主机反复重载页面；按实际负载单独评估启用 |
| `NetworkPredictionOptions` | `2` | 关闭 DNS 预取、连接预热和页面预渲染 |
| `BackgroundModeEnabled` | `false` | 关闭最后一个浏览器窗口后，不继续运行 Chrome 后台应用 |
| `AutoplayAllowed` | `false` | 限制媒体自动播放；正在打开的标签需要重新打开才应用此项变化 |

此文件不会随 Node 服务启动自动安装。它是 Linux Google Chrome 的**机器级策略，会影响这台服务器上的所有 Google Chrome 环境**，适合专门用于本项目的服务器。如果服务器还有其他 Chrome 用途，应先评估这一范围。Chromium 或其他浏览器使用的策略目录可能不同。

在项目目录下执行以下可选安装命令。若目标文件已经存在，命令会停止，以免覆盖现有配置；请先检查并备份现有文件。

```bash
policy_dir=/etc/opt/chrome/policies/managed
policy_file="$policy_dir/account-region-lab-low-memory.json"
sudo install -d -m 0755 "$policy_dir"
if sudo test -e "$policy_file"; then
  printf '%s\n' '策略文件已存在；请先检查并备份，再决定是否更新。' >&2
else
  sudo install -m 0644 deploy/linux/chrome-low-memory.json "$policy_file"
fi
```

保存浏览器中正在进行的操作，然后在工作台关闭并重新打开环境。在远程浏览器地址栏输入 `chrome://policy`，点击重新加载策略，确认以上四项被识别且没有错误。`chrome://settings/performance` 可以查看内存节省设置。v0.8.0 曾默认最大档回收；现场用户反馈更卡后撤回，不能仅凭临时空白页面测试认定该档能改善真实网页。

回退时只移除本项目安装的策略文件，然后重新打开环境：

```bash
sudo rm -- /etc/opt/chrome/policies/managed/account-region-lab-low-memory.json
```

不要删除整个策略目录。回退后，如仍有其他机器或用户策略，这些策略会继续生效。

内存节省程序不是硬性内存上限。当前正在使用的页面仍需完整运行，某些后台页面也不会被回收。重新切回已回收的标签时可能重新加载页面并使用代理流量，因此先保存未完成的编辑。它也不会把动态代理变成固定 IP，或保证多个重型网页在 1 GB 内存上同时流畅运行。

更省资源的用法是按需打开环境，用完后在工作台关闭，保留其独立账号资料，下次继续使用。仅隐藏远程画面不会关闭服务器浏览器。需要长期同时运行多个 Gmail 或视频页面时，仍需要根据实际负载增加服务器内存和 CPU。

## 更轻的远程显示方案

当前轻量模式保留 Xvfb + x11vnc，以便沿用已验证的独立桌面和网关。下一种可比较的方案是 TigerVNC Xvnc：它合并 X server 与 VNC 服务，减少一个采集环节，但不会减少 Chrome 页面自身的内存。只有桌面采集 CPU 确实占主要开销时，迁移才更值得优先做。KasmVNC 则涉及更大的传输和鉴权迁移，不宜把它当成 1 GB 主机的内存补救。

另一个架构是本机运行浏览器、服务器只转发代理，会显著减少服务器渲染工作；但需要本机客户端，和“所有账号浏览器都运行在海外服务器”的目标不同。项目当前仍保持全部账号浏览器在服务器运行。

## 官方定义

策略字段依据 Chromium 的官方定义，核对日期为 2026-10-10：

- [HighEfficiencyModeEnabled](https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Miscellaneous/HighEfficiencyModeEnabled.yaml)
- [MemorySaverModeSavings](https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Miscellaneous/MemorySaverModeSavings.yaml)
- [NetworkPredictionOptions](https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Miscellaneous/NetworkPredictionOptions.yaml)
- [BackgroundModeEnabled](https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Miscellaneous/BackgroundModeEnabled.yaml)
- [AutoplayAllowed](https://github.com/chromium/chromium/blob/main/components/policy/resources/templates/policy_definitions/Miscellaneous/AutoplayAllowed.yaml)
