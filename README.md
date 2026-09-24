# dsh Jev Router

这是一个独立的 DeepSeek Harness Cordis 插件，提供 Host 路由和 Web 设置页。插件只接管选择了 Auto 的主会话；关闭、固定模型和子 Agent 都保持 dsh 原有行为。当前策略版本为 `jev-router/v1`。

## 开发安装与启动

下面的命令按你从源码运行 dsh 的目录组织。先在插件仓库构建，再把本地包安装到实际运行 Web 的 `web` profile：

```sh
pnpm install
pnpm run build
```

切换到 dsh 源码仓库（本项目当前使用的路径是 `/Users/zong/Desktop/Project/GitHub-fork/zong-deepseek-harness`），执行 profile 级安装和启动：

```sh
cd /Users/zong/Desktop/Project/GitHub-fork/zong-deepseek-harness
pnpm dsh plugin --profile web add file:/Users/zong/Desktop/Project/deepseek-plugin
pnpm dsh plugin --profile web why @zong/dsh-jev-router
pnpm dsh web \
  --patch /Users/zong/Desktop/Project/deepseek-plugin/examples/jev-router.patch.yml
```

首次安装后，日常开发只需在插件仓库重新执行 `pnpm run build`，然后重新启动 dsh Web；如果 profile 中已经安装过该本地包，不要重复执行 `add`，可用上面的 `why` 命令确认安装状态。停止后再次启动仍使用同一条 `pnpm dsh web --patch ...` 命令。启动器输出的完整认证 URL 才是应访问的地址。

Host 入口是包根导出，Web loader 会依据 `package.json` 的 `dsh.client` 声明加载 `./client`。`pnpm run build` 会把浏览器入口打成 dsh Client Modules 所需的 lazy-CJS 注册脚本，并校验 `window.__ModuleLoader__.load(...)` 的插件 id 和 factory；普通 ESM 客户端产物会让同一 combo 中的所有插件一起显示 `import failed`。示例 patch 在现有 Web profile 上追加插件，不修改 dsh 主循环。启动后请使用 dsh 日志输出的完整认证 URL，而不是直接访问裸 `http://127.0.0.1:3080/`。

首次安装的 `jev-router` 设置默认关闭。开启后，在设置页的 `apiKey` 字段直接填写 TypeSafe Jev API Key。该值会保存到插件设置并随设置同步，不再从 `TYPESAFE_API_KEY` 环境变量或 dsh credentials 服务读取；页面使用密码控件避免直接展示已填写的密钥，但请按你的部署安全策略保护设置存储和同步链路。

设置页还提供完整输入规模阈值、`keep`／`upgrade_only` 超限策略、切换后的保持回合数和缓存感知开关。阈值默认 32,768，保持回合默认 2；`null` 和 `0` 分别禁用阈值与保持规则。输入规模由 dsh token-meter 对系统提示、工具定义、历史和工具结果做完整请求估算，并标注为估算值；无法可靠估算时不会为了省钱降级。供应商未报告缓存字段时显示为未知，显式 `cacheReadTokens: 0` 才表示零命中。

高级设置还提供 `routeReasoning`、`jevTimeoutMs` 和 `jevMaxStateChars`，默认分别为开启、2,000 ms 和 6,000 个 Unicode 字符。Jev 在一次分类请求中同时看到候选模型实际声明的思考档位；插件只接受目标适配器目录中的档位，关闭思考路由时保留当前有效选择或适配器默认行为。超时覆盖候选解析和 Jev 网络调用的总等待，材料预算包含 JSON 字段名、结构和全部证据，过大的单条内容会明确标记截断。

`showDecision` 与 `recordMetrics` 是两个相互独立的开关，默认均开启：前者在回合尾部显示建议模型、实际模型、规则原因、策略/Jev 版本、分类耗时、思考档位和实际请求的 token/cache usage；后者把相同的无原文结构化记录写入 dsh logger。关闭展示不会关闭路由，关闭记录也不会删除下一回合所需的短期缓存证据。usage 缺失字段显示为“未知”，不会推算费用或节省。

## 路由行为

每个由用户输入开始的 turn 在系统提示组装前最多调用一次 TypeSafe System One（`jev-latest`，当前 endpoint 为 `https://api.typesafe.ai/v1/systemone`）。插件使用当前 `questions.model` Choice 请求和 `answers.model.choice` 响应，把每个候选模型及其适配器声明的思考档位编码为可追踪的路由选项，再映射回 provider/model。Jev 返回的 provider/model 必须匹配设置页白名单；同一 turn 的工具续步和请求重试沿用已经组装的路线。分类失败、超时、缺少 API Key 或非法选择会沿用当前请求路线，没有当前路线时使用 `defaultModel`。

分类材料只用于 Jev 判断，执行模型仍使用 dsh 完整会话历史。`jevMaxStateChars` 仅限制发往 TypeSafe 的证据序列化长度；它不会裁剪执行上下文。超过阈值时，`keep` 保留当前路线；`upgrade_only` 仅在候选能力档位明确从 economy 升到 capability 时放行升级。切换后的完整用户回合由持久化日志重建，工具 step 不单独计数，失败和取消不计为保持回合。

短追问会附带最近的用户任务、助手提议和工具结果片段作为分类证据，且不会替代执行历史。每个用户 turn 最多分类一次；同一 turn 的工具 step 和供应商重试使用已经采用的模型与思考档位。手动模型选择写入固定模式并取消未生效的分类；会话标题栏会显示并切换 Auto/Fixed，也可用 `/jev-auto` 与 `/jev-fixed` 命令切换。模式与实际路线通过会话事件持久化，恢复已开始的 turn 时沿用已记录请求头，不重复分类；无法恢复的缓存命中保持未知。

## 当前票据范围

本版本覆盖逐回合路由、基础候选白名单、默认关闭、直接 API Key 设置、设置持久化、长上下文切换守卫、持久化保持计数、缓存证据隔离、思考强度/恢复、可卸载生命周期和可追溯路由指标。真实 ctapi/TypeSafe 验收与固定 Pro 对比记录见 [docs/live-acceptance.md](docs/live-acceptance.md)。没有 API Key 或网关不可用时，文档中的项目必须保持“未验证”，不能用测试替身替代真实结果。

## 诊断记录格式

启用 `recordMetrics` 后，每个已完成或失败回合最多写一条 `event: "jev-router/decision"` 的 JSON 记录。记录包含 `policyVersion`、`sessionId`、`turn`、`suggested`、`actual`、`reason`、`fallback`（如有）、`classificationMs`、`classificationUsage`（如 Jev 返回）以及实际执行请求的 `usage`。它不包含用户输入、工具原文或凭据；缓存字段沿用 dsh 的 disjoint 计数语义（`inputTokens` 是未缓存输入，缓存读取/写入单独计数）。

## 安装后快速验收

1. 构建并通过 `examples/jev-router.patch.yml` 加载插件。
2. 在 Jev 自动路由设置页的 `apiKey` 密码框中直接填写 TypeSafe System One API Key；不要把密钥写入 `cordis.yml`、日志或截图。
3. 保持插件关闭发送一条消息，确认没有 Jev 请求；开启插件并把会话切到 Auto，再发送常规问题和复杂工具任务，确认出站请求模型与会话尾部决定一致。
4. 分别关闭 `showDecision`、`recordMetrics`，确认只影响对应的界面或 logger；再刷新 profile，确认设置仍持久化。
5. 记录真实模型与固定 Pro 的对比结果，不把模型占比或单价差写成节省结论。完整表格和命令见 [docs/live-acceptance.md](docs/live-acceptance.md)。
