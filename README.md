# DSH Personal Assistant

面向 DeepSeek Harness 的本地个人助手插件，正在开发中。公开仓库：[McLinWxl/dsh-personal-assistant](https://github.com/McLinWxl/dsh-personal-assistant)。

以时间线组织长期记忆，让工作、生活和跨年度项目共享适用经验；结合日历、任务执行、工具维护与微信对话。数据集中存放在用户选择的本地目录，支持迁移。

## 当前进展

- 已完成 SQLite 记忆原型：新项目、旧经验关联、自动整理、撤回时保留人工修改。
- 已通过真实 DSH Agent、模型与会话恢复验证上述数据链路；摘要完整性和时区展示仍需实现改进。
- Windows、macOS、Linux 的 CI 各通过 37 项测试；已配置版本标签触发的打包发布流程。见 [首次 CI 结果](https://github.com/McLinWxl/dsh-personal-assistant/actions/runs/41756059955)。
- 正式插件、界面、日历、微信接入和完整迁移仍在开发计划中。当前仓库尚不能直接作为插件安装，也没有发布可下载版本。

## 安装与发布

正式包通过 GitHub Releases 分发。在 DSH 的插件管理中添加该版本的 `.tgz` 下载地址。首次安装验收完成后，这里会补充可用的安装链接与适用 DSH 版本。

发布约定、安装入口和升级规则见 [GitHub 同步与发布](docs/10-distribution.md)。

## 设计与验证

| 文档 | 内容 |
|---|---|
| [能力与产品设计](docs/05-assistant-design.md) | 记忆、日历、任务、工具、微信和迁移 |
| [实现与验收](docs/06-assistant-implementation.md) | 模块、数据模型、DSH 接口、阶段与验收 |
| [长期个人记忆](docs/07-lifelong-memory.md) | 时间主线、多维关联、整理、遗忘与跨年复用 |
| [记忆链路验证](docs/08-memory-validation.md) | 事务、关联、撤回、人工编辑与到期回收 |
| [真实会话与模型验证](docs/09-live-session-validation.md) | 自然语言创建、提炼、整理和会话恢复 |
| [GitHub 同步与发布](docs/10-distribution.md) | 自动检查、打包、版本与安装链接 |
| [技术原型](spikes/memory-lifecycle/README.md) | 可运行代码与合成场景结果 |

## 开发

Node.js 24.9 或更新版本；CI 使用 24.21.0。

```sh
npm test
```

测试使用临时目录与虚构资料，不需要模型账号或安装 DSH。真实模型实验另行运行，会使用本机配置的模型账户；参见原型文档。

根目录是开发工程，正式 bundle 计划位于 `plugins/dsh-personal-assistant/`。发布脚本只打包该目录，业务数据不随源码和安装包分发。

公开源码的许可证尚待项目所有者确定，首个版本发布前补齐。DSH 本身及其第三方依赖遵循各自许可证。
