# DSH Personal Assistant

DeepSeek Harness 的本地个人助手插件。以时间组织记忆，让工作、生活和跨年度项目共享适用经验；提供日历、任务执行、工具维护和微信入口。

正式源码位于 `plugins/dsh-personal-assistant/`，当前版本 `0.1.0-alpha.1`，MIT 许可证。适配 DSH `0.2.1-rc.5`，运行时需要 Node.js 24.9 以上版本。

## 功能

- 所有工作区的 DSH 原生对话共享记忆能力，继续使用各自的模型、工具、权限和工作目录。
- 原生“个人助手”工作区承接日常需求、任务和整理报告；“助手管理”提供业务管理页面。
- 记忆保留时间、领域、主题和项目关系；定期分类与归并，撤回时保留之后的人工修改。
- 默认保留普通对话归档 90 天、撤回差量 72 小时，均可设置；到期回收。
- 月历、周历、日程列表、重复事件单次调整、时区与 ICS。
- 真实任务执行、结果核对、工具草稿、固定版本工作流及维护建议。
- 微信官方机器人入口、主人绑定、文字和附件收发、通知；账号由用户最后绑定验证。
- 单目录保存业务内容、工具、附件和设置；支持导出、校验和迁移。微信登录凭据由本机系统安全存储保护，新设备重新扫码。

## 安装

开发包已可生成并在隔离 DSH 中安装。公开下载地址将在 GitHub Release 资产实际发布后补充；仓库地址本身不是安装包。

```sh
cd plugins/dsh-personal-assistant
npm ci
npm run build
npm pack --ignore-scripts
```

在 DSH 的插件管理中添加生成的 tgz 路径；也可运行：

```sh
dsh plugin --profile desktop add file:/absolute/path/dsh-personal-assistant-0.1.0-alpha.1.tgz
```

启动后在原生“个人助手”工作区对话；打开“助手管理”的设置选择数据目录和 DSH 已配置的模型。模型与基础助手通过下拉选择，目录通过浏览选择。微信点击“连接微信”后扫码，本机重启自动恢复；新设备重新扫码。

## 文档

| 文档 | 内容 |
|---|---|
| [产品设计](docs/05-assistant-design.md) | 七项核心能力和使用方式 |
| [技术实现](docs/06-assistant-implementation.md) | 模块、数据模型与接口 |
| [长期记忆](docs/07-lifelong-memory.md) | 时间、关联、整理和遗忘 |
| [界面与扫码连接](docs/13-interface-and-device-login.md) | 页面层级、默认设置、系统凭据与验证记录 |
| [原生工作区接入](docs/12-native-workspace-integration.md) | 全局记忆、原生对话与整理报告 |
| [正式实施与验收](docs/11-implementation-progress.md) | 当前能力、真实运行发现和修复 |
| [实测检查记录](docs/validation/formal-live-20261104.json) | 合成资料的真实模型链路 |
| [发布流程](docs/10-distribution.md) | 三系统 CI、打包与 GitHub Release |
| [早期记忆原型](docs/08-memory-validation.md) | 原型事务与撤回测试 |
| [早期会话验证](docs/09-live-session-validation.md) | 原型自然语言流程 |

## 开发验证

```sh
npm test
npm ci --prefix plugins/dsh-personal-assistant
npm run check --prefix plugins/dsh-personal-assistant
npm run build --prefix plugins/dsh-personal-assistant
npm test --prefix plugins/dsh-personal-assistant
npm run test:package --prefix plugins/dsh-personal-assistant
```

自动测试使用临时目录和合成资料。真实会话实验使用 DSH 中已配置的账户。源码和安装包不包含业务数据库、凭据、本机会话或个人资料。

本机已完成正式插件的 macOS 真实 DSH 验证。微信真实扫码绑定已完成，消息收发待验证；Windows、Linux 原生界面仍需相应环境，最新结果以实施记录为准。DSH 原生会话日志与模型账号由宿主管理，迁移插件目录后仍需配置宿主账户。
