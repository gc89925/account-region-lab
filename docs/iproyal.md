# IPRoyal 参数设置

适用于 `geo.iproyal.com` 的住宅代理。把商家导出的完整代理粘贴到“代理地址”，展开“IPRoyal 参数设置”，修改后点击“应用参数”，再诊断和保存。未应用的编辑不会被当成已生效配置。

所有后缀都是认证密码的一部分。面板只显示路由字段，不显示基础密码；已保存环境的 session 只显示脱敏提示，留空保持原值。只修改有变动的参数，原用户名、基础密码和未修改的 session 继续保留。

| 字段 | 用途与输入 | 注意事项 |
| --- | --- | --- |
| `country` | 国家代码，如 `ng`、`ph` | 固定国家模式只用单个国家；多国会让商家随机选择 |
| `region` | 大区，从下拉框选择 | 这是非洲、亚太等大区，不是州 |
| `state` | 商家提供的州代码 | 需要国家；官方教程主要覆盖美国，其他国家以商家支持为准 |
| `city` | 商家提供的城市代码 | 需要国家；不会自动猜测或翻译城市代码 |
| `isp` | 商家提供的运营商代码 | 同时指定国家和城市；需要相应账号权限 |
| `session` | 8 位英文字母或数字 | 换值可能换 IP；不会后台自动生成新会话 |
| `lifetime` | 1 秒至 7 天，如 `168h` | 建议按商家格式使用单个 s / m / h 单位；时长不是在线保证 |
| `streaming` | 高端代理池 | 需要有效订阅，不等于视频站点解锁保证 |
| `killswitch` | 原粘性节点离线后不自动替换 | 严格模式启用；首次启用可能改变出口 |
| `forcerandom` | 商家的随机出口选项 | 与项目严格固定模式冲突 |
| `skipispstatic` | 排除静态 ISP | 需要商家开通；它不是固定出口选项 |
| `skipipslist` | 已有 IP 排除列表的 26 位 ID | 需要商家开通并预先创建列表 |
| `geolocation` | 纬度,经度,半径，可加 `,strict` | 半径单位英里，至少 10；不加 strict 时商家可退到范围以外 |
| `set` | 商家提供的国家集合代码 | 严格固定国家模式不接受集合 |

可选项默认为不添加；关闭开关会删除对应后缀，恢复供应商默认行为。缺少依赖字段、值格式错误或重复参数会显示原因，不静默删改其他参数。定位越细，可选节点可能越少，并非填得越多越稳定。

公开文档没有完整、与账号权限一致的城市、州和 ISP 清单；该清单需要商家 API 凭据。本项目不会要求你把 API token 填在代理密码里，也不会猜造可用值。面板做语法和依赖校验，具体供应与权限仍由商家决定。

官方参考：

- [地域与经纬度](https://docs.iproyal.com/proxies/residential/proxy/location)
- [粘性会话、时长与离线保护](https://docs.iproyal.com/proxies/residential/proxy/rotation)
- [高端代理池](https://docs.iproyal.com/proxies/residential/proxy/high-end-pool)
- [排除静态 ISP](https://docs.iproyal.com/proxies/residential/proxy/skipping-static-isp)
- [IP 排除列表](https://docs.iproyal.com/proxies/residential/proxy/ip-skipping)
- [账号可用位置与国家集合](https://docs.iproyal.com/proxies/residential/api/access)

核对日期：2026-10-09（上海时间）。
