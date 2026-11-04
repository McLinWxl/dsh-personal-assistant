# DSH Personal Assistant

DeepSeek Harness 的本地个人助手插件，采用 MIT 许可证，目前处于 Alpha 阶段。将工作与生活中的记忆、项目、日程、任务和工具统一管理，并提供微信入口。

对话使用 **DSH 内置工作区和会话页面**。所有工作区的对话均可触发记忆提炼和召回；“个人助手”工作区承接助手任务、微信对话和定期整理报告，“助手管理”提供管理界面。

## 安装与开始使用

适配 DSH `0.2.1-rc.5`，运行环境需要 Node.js `24.9` 或以上版本。

1. 打开 [GitHub Releases](https://github.com/McLinWxl/dsh-personal-assistant/releases)，选择版本并复制 `dsh-personal-assistant.tgz` 的下载链接。
2. 在 DSH「插件 → 添加插件」中粘贴链接，安装并启用插件。
3. 在 DSH 配置可用的模型账户，在「助手管理 → 设置」检查数据目录和助手工作区，然后在 DSH 内置会话中使用。

模型和“基础助手”默认跟随 DSH。基础助手决定继承的角色与工具配置；工作目录默认使用数据目录下的 `projects/workspace`，可通过目录选择器更改。

微信在「设置 → 微信」点击“连接微信”后扫码。登录凭据保存在本机系统安全存储，迁移到新设备后重新扫码。macOS 使用钥匙串，Windows 使用凭据管理器，Linux 需要可用的 Secret Service。

## 能力与整体设计

- **长期记忆**：以时间串联经历、事实和方法，通过领域、主题与项目关系关联工作和生活；相似项目可复用过去的经验，同时保留各自身份。
- **自动维护**：定时提炼、归并和清理记忆，生成变更报告。默认保留普通对话归档 90 天、撤回内容 72 小时，均可调整；撤回时保留后续人工修改，冲突交由用户处理，过期撤回内容自动清理。
- **日常与任务**：通过对话管理项目、日程和任务，支持重要性与紧急程度标记、日历及 ICS 导入导出；任务交由 DSH 执行，并将结果关联到项目与记忆。
- **工具与微信**：管理工具草稿、版本和启用状态，定期提出维护建议；微信与桌面共用助手能力和数据。

| 层次 | 职责 |
| --- | --- |
| Host | 接入 DSH 全局会话事件、工作区、定时任务和微信 |
| Agent | 提供记忆上下文和助手工具，复用 DSH 模型与执行能力 |
| Storage Worker | 独立处理 SQLite 存储、事务、变更记录与撤回 |
| Client | 提供记忆、日历、任务、工具和设置等管理页面 |

插件在 DSH 运行期间工作，恢复运行后补处理到期任务。普通会话与整理报告分开识别，避免报告内容反复生成记忆。

## 数据与迁移

默认数据目录为用户目录下的 `Documents/DSH Assistant`，集中保存设置、记忆、任务、工具及相关文件。等待任务完成后，在设置中导出数据目录；新设备安装插件后，选择导出的目录即可继续使用。

DSH 自身的会话历史、模型账户和外部工具依赖由 DSH 管理，需另行迁移或配置。一个数据目录由一个运行中的插件实例使用。

## 源码与本地构建

```sh
git clone https://github.com/McLinWxl/dsh-personal-assistant.git
cd dsh-personal-assistant
npm ci --prefix plugins/dsh-personal-assistant
npm run check
npm run build
npm run check:package
mkdir -p dist
npm pack ./plugins/dsh-personal-assistant --ignore-scripts --pack-destination dist
```

将 `dist/` 中生成的 `.tgz` 文件添加到 DSH。

| 目录 | 用途 |
| --- | --- |
| `plugins/dsh-personal-assistant/src/` | 插件业务源码 |
| `plugins/dsh-personal-assistant/scripts/` | 构建与安装包校验 |
| `scripts/`、`release/`、`.github/workflows/` | 发布配置和 GitHub 自动化流程 |
| `test/` | 本地测试及历史原型测试，不提交 Git、不进入安装包 |
| `plugins/dsh-personal-assistant/lib/`、`dist/` | 自动生成的运行文件和安装包，不提交 Git |

公开仓库保留源码、构建与发布配置；安装包只包含明确列出的运行文件、插件元数据、README 和许可文件。构建时从根目录复制 README 与 LICENSE，并生成依赖许可声明，无需维护重复文档。版本标签触发三系统构建与安装包校验，通过后自动创建 GitHub Release。

## 许可证

[MIT](LICENSE)。安装包内的 `THIRD_PARTY_NOTICES.md` 收录依赖许可。
