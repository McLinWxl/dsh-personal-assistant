# 记忆生命周期技术验证

验证目标：创建新项目 → 关联一年前的经验 → 自动整理 → 撤回并保留后来人工修改。

这是独立、不可发布的技术原型。所有场景资料均为虚构，数据库在临时目录创建并清理。DSH 验证在独立进程中读取本机运行时，不安装插件、不修改用户 profile。离线验证不连接模型；verify:live 使用真实 DSH Agent 与账号模型服务，不连接微信。

## 运行

在本目录使用 Node 24.9+：

```sh
npm test
npm run demo
npm run verify:dsh

# 使用已登录的 DSH 账号执行真实模型验证
DSH_MODEL=deepseek-v4-pro DSH_REASONING_EFFORT=low npm run verify:live
```

没有第三方 npm 依赖，无须执行安装。`verify:dsh` 在 macOS 默认寻找 `/Applications/DeepSeek Harness.app`。其他安装位置可设置 `DSH_EXECUTABLE` 和 `DSH_MODULES`，分别指向可使用 `ELECTRON_RUN_AS_NODE=1` 的应用可执行文件，以及 DSH 的 `node_modules` 目录。真实 DSH 宿主与模型接入目前只在 macOS 验证。

## 代码

| 文件 | 内容 |
|---|---|
| [memory-store.mjs](src/memory-store.mjs) | SQLite、FTS5 检索、结构化归并、字段版本、差量撤回、事务发件箱与过期回收 |
| [fixtures.mjs](src/fixtures.mjs) | 跨年度工作与生活的虚构资料、无关/过期/私密记录 |
| [scenario.mjs](src/scenario.mjs) | 直接数据库与 DSH 工具服务共用的完整链路验收 |
| [host-plugin.mjs](src/host-plugin.mjs) | 8 个隔离验证工具，复用真实 DSH `defineTool` 与注册服务 |
| [context-schema.mjs](src/context-schema.mjs) | 可配置条件词表与字段、类型、枚举校验 |
| [model-plugin.mjs](src/model-plugin.mjs) | 自然语言提炼、选择性关联、独立语义整理与人工编辑工具 |
| [dsh-runtime.mjs](src/dsh-runtime.mjs) | 已安装 DSH 的 Agent、会话持久化、账号模型与重试服务 |
| [live-model.mjs](scripts/live-model.mjs) | 真实模型驱动的五轮自然语言验收及原生会话恢复 |
| [lifecycle.test.mjs](test/lifecycle.test.mjs) | 30 项测试，包括真实子进程退出恢复与目录搬移 |

## 结果

2026-11-04，GitHub CI 在 Windows、Ubuntu / Linux、macOS 的 Node.js 24.21.0 上分别通过全部 37 项测试：本原型 30 项，加发布脚本 7 项；失败和跳过均为 0。运行链接和对应提交见 [发布验证记录](../../docs/10-distribution.md#6-本轮验证记录)。

2026-11-03，macOS arm64：本机 Node 25.2.1 和 DSH 自带 Node 24.21.0 均通过 30 项测试。DSH 0.2.1-rc.5 的真实 Cordis/ToolRuntime 中同一链路通过，工具参数校验、卸载和重新启用通过。

真实 deepseek-v4-pro 模型完成 3 个会话、5 轮任务：创建与提炼、跨年度关联、整理、人工改写、原生会话恢复与撤回。数据断言通过；摘要用途遗漏和截止时间的时区标注错误单独记录在会话报告中，尚未作为已解决项交付。

- [真实模型会话结果](artifacts/live-model.json)
- [完整场景](artifacts/scenario.json)
- [DSH 工具服务场景](artifacts/dsh-host.json)
- [DSH 测试结果](artifacts/dsh-tests.json)
- [测试逐项输出](artifacts/dsh-tests.tap)

JSON 结果包含运行时间、运行时版本和源码 SHA-256。每次重跑生成新的随机对象 ID 和结果文件，场景时间固定为 2026-11-03 08:00（上海时区）。72 小时通过注入时钟验证，没有实际等待三日。

## 当前实现方式

检索使用中文分词、通用虚词过滤和 FTS5，结合所有者、用途、适用条件与有效时间过滤；归并仅处理已结构化且命题与适用条件相同的事实/方法。新增真实模型抽取与独立整理会话：保留引用，提交版本化语义归并计划；工具对共享条件词表、身份、来源和写入版本做校验。向量检索和独立语义质量评测仍在后续。

恢复差量暂存于同一 SQLite 事务中的专用表，原型为明文；没有整库定时备份。正式版需要加密差量及大文件引用回收。当前命令是同步验证入口，尚未接入 Worker、定时调度、界面通知或远程用户身份认证。`memory_inspect` 是测试专用工具，不应直接进入正式发布包。

更完整的结论及设计调整见 [数据与工具验证](../../docs/08-memory-validation.md) 和 [真实会话验证](../../docs/09-live-session-validation.md)。

## 真实模型运行

DSH_CREDENTIALS 可指定凭据文件，默认读取用户的 .dsh/.credentials.yaml。DSH_MODEL 指定该账户可用的模型；DSH_REASONING_EFFORT 指定推理强度，默认 high。工具输入、输出和会话资料都是合成内容。

账号服务使用权限为 0600 的临时凭据副本，目录权限为 0700；正常结束和受控失败后清理。这样供应方拒绝令牌时只影响实验副本，不会改写 Desktop 的登录文件。报告不导出凭据、请求认证头或模型推理内容。

真实模型场景用实际运行时间记录创建、整理和撤回截止时间；历史事件日期来自虚构的自然语言资料。其原生 JSONL、SQLite 与凭据副本位于临时目录，运行后清理；项目保留公开答复、工具调用和验收状态的 JSON 报告。此前的固定时钟事务测试仍单独运行。

服务错误、超时、工具失败和数据库断言失败都会让命令以非零状态结束。live-model-progress.json 是轮次检查点，最终结果以 live-model.json 的 passed 字段为准。失败尝试另存为带原因的记录，不计入通过结果。
