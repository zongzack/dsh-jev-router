# dsh Jev Router 真实集成与固定 Pro 对比记录

本文是 04 票的可复现验收记录模板。它把自动路由、Jev 分类和两个 ctapi 路线的真实调用分开记录；任何没有真实凭据、真实网关响应或完整 dsh Web profile 证据的项目都必须写成 **未验证（UNVERIFIED）**，不能用单元测试或 mock 响应改写状态。

## 环境与安装

```sh
cd /Users/zong/Desktop/Project/deepseek-plugin
pnpm install
pnpm run build

cd /Users/zong/Desktop/Project/GitHub-fork/zong-deepseek-harness
pnpm dsh plugin --profile web add file:/Users/zong/Desktop/Project/deepseek-plugin
pnpm dsh web --patch /Users/zong/Desktop/Project/deepseek-plugin/examples/jev-router.patch.yml
```

这里使用 dsh 的 profile 级插件安装命令；仅执行 `pnpm add --workspace-root` 或在 dsh 工作区根目录执行 `pnpm link`，不会把插件安装到正在运行的 `web` profile。若插件已经安装，可用 `pnpm dsh plugin --profile web why @zong/dsh-jev-router` 检查，不要重复执行 `add`。

在 Jev 自动路由设置页的 `apiKey` 密码框中直接填写 TypeSafe System One Bearer key。不要把 key 写入 `cordis.yml`、日志或截图；设置持久化与同步链路会保存该值，需按部署安全策略保护。插件通过当前 TypeSafe endpoint `https://api.typesafe.ai/v1/systemone` 发送 `questions.model` Choice 请求，并从 `answers.model.choice` 还原路由。默认设置是初始值，不代表实测最优：插件默认关闭，候选是 `ctapi/deepseek-v4-flash-vip`（economy）和 `ctapi/deepseek-v4-pro-vip`（capability），阈值 32,768、保持 2 回合、Jev 超时 2,000 ms、材料预算 6,000 Unicode 字符。

## 真实路线验收表

| 项目 | 证据 | 状态 |
| --- | --- | --- |
| Flash 基本生成 | dsh 出站请求、assistant/message、usage | **未验证（本工作区无 ctapi 凭据）** |
| Flash 工具调用 | 同一 turn 的工具 step 使用同一模型 | **未验证** |
| Flash 上下文能力 | 长输入兼容性与窗口余量 | **未验证** |
| Flash 实际思考档位 | LLM 目录与网关请求参数 | **未验证** |
| Pro 基本生成 | dsh 出站请求、assistant/message、usage | **未验证（本工作区无 ctapi 凭据）** |
| Pro 工具调用 | 同一 turn 的工具 step 使用同一模型 | **未验证** |
| Pro 上下文能力 | 长输入兼容性与窗口余量 | **未验证** |
| Pro 实际思考档位 | LLM 目录与网关请求参数 | **未验证** |
| Jev → ctapi 端到端 | TypeSafe 响应、规则结果、实际请求三者一致 | **未验证（本工作区无 TypeSafe 凭据）** |

完成验证时，每一格至少附：时间、脱敏的 session/turn、出站 provider/model、是否有 `usage`、`cacheReadTokens`/`cacheWriteTokens` 是否由网关报告、思考档位是否由目录声明。缺失字段写“未知”，不要写 0。

## 自动路由与固定 Pro 对比

对同一组任务各运行一次冷缓存和一次暖缓存；固定 Pro 与 Auto 使用相同完成标准、相同工具权限和相同最大输出。不要为了命中缓存重跑已有用户任务或工具副作用。

| 场景 | 完成标准 | 固定 Pro：修正/耗时/usage | Auto：路线/修正/耗时/分类开销/usage | 缓存条件 | 结论 |
| --- | --- | --- | --- | --- | --- |
| 常规任务 | 一次输出通过检查 | 待填写 | 待填写 | 冷/暖 | 仅据样本 |
| 复杂推理 | 无人工修正或记录修正次数 | 待填写 | 待填写 | 冷/暖 | 仅据样本 |
| 短追问 | 延续前一任务且无信息丢失 | 待填写 | 待填写 | 冷/暖 | 仅据样本 |
| 长上下文 | 不截断执行历史并完成任务 | 待填写 | 待填写 | 冷/暖 | 仅据样本 |

总费用只有在网关同时提供可信价格和 usage 时才计算，并包含 Jev 分类、执行请求和重试；否则写“费用未知”。小样本不能推出普遍等质量或节省比例，也不能用 economy 占比、Jev 置信度或名义单价差替代质量与总成本。

## 无密钥回放（可验证的本地部分）

仓库测试会用替身网络但保留真实 Loader、Session、settings、LLM 适配器和会话投影，覆盖：关闭零 Jev 调用、开启 Auto 的实际出站路线、固定模型优先、同轮工具续步、长上下文保留、分类回退、设置独立开关、usage/cache 缺失标记、恢复和卸载。它证明插件组合和持久化形状，不证明任何真实供应商可用性；真实路线表中的 UNVERIFIED 项必须在有凭据的 profile 中重新执行。

## 当前运行结果（2026-09-23）

- 本地类型检查、构建和完整 Vitest 套件：通过。
- 真实 Flash/Pro ctapi 调用：**未验证**，当前环境没有相应凭据。
- 真实 TypeSafe Jev 调用：**未验证**，当前环境没有 TypeSafe 凭据。
- 固定 Pro 对比数据：**未完成**；没有在无授权情况下发起付费模型请求。
