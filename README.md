# dsh Jev Router

这是一个独立的 DeepSeek Harness Cordis 插件，提供 Host 路由和 Web 设置页。插件只接管选择了 Auto 的主会话；关闭、固定模型和子 Agent 都保持 dsh 原有行为。

## 开发安装

在插件仓库执行构建，然后把包目录加入 dsh profile 的插件清单：

```sh
pnpm install
pnpm run build
```

开发时可在 dsh 仓库安装本地包：

```sh
cd /Users/zong/Desktop/Project/GitHub-fork/zong-deepseek-harness
pnpm add --workspace-root file:/Users/zong/Desktop/Project/deepseek-plugin
pnpm dsh web --patch /Users/zong/Desktop/Project/deepseek-plugin/examples/jev-router.patch.yml
```

Host 入口是包根导出，Web loader 会依据 `package.json` 的 `dsh.client` 声明加载 `./client`。示例 patch 在现有 Web profile 上追加插件，不修改 dsh 主循环。

首次安装的 `jev-router` 设置默认关闭。开启后，设置页只保存 `apiKeyEnv` 凭据引用，不会读回或记录 TypeSafe 密钥明文。凭据值应通过 dsh credentials 服务写入，例如 Web Models 页面或部署使用的 credentials provider。

## 路由行为

每个由用户输入开始的 turn 在系统提示组装前最多调用一次 TypeSafe System One（`jev-latest`）。Jev 返回的 provider/model 必须匹配设置页白名单；同一 turn 的工具续步和请求重试沿用已经组装的路线。分类失败、超时、缺凭据或非法选择会沿用当前请求路线，没有当前路线时使用 `defaultModel`。

分类材料只用于 Jev 判断，执行模型仍使用 dsh 完整会话历史。`jevMaxStateChars` 仅限制发往 TypeSafe 的证据序列化长度；它不会裁剪执行上下文。

## 当前票据范围

本版本覆盖逐回合路由、基础候选白名单、默认关闭、凭据引用、设置持久化和可卸载生命周期。上下文阈值、保持回合、缓存证据、恢复竞态及完整指标面板由后续票据补齐。
