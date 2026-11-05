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

- **项目树**：最多四层的单亲树，支持移动、合并、明确分配成员的拆分、归档、恢复和真正删除。稳定 key 与派生路径分离；同父名称和全局别名分别校验唯一性。
- **自动归属**：持久化会话默认项目，显式指定项目优先；同一事项继续讨论时复用，独立子事项才建子项目。自动创建需要明确请求或两条去重后的用户来源。年份、批次等场景条件保持独立。
- **统一关系**：记忆、任务、日程和工具通过 `contains` 保持唯一归属，通过 `applies_to` 关联多个适用项目。业务正文不再保存第二份项目归属。
- **自动维护**：提炼与归并记忆，并运行结构、归属整理。项目变化自动执行并写入日报；资料不足或操作失败会留下记录，随新资料继续处理。结构纠正使用正向操作。
- **日常与任务**：自然语言日程、任务、日历及 ICS 导入导出；执行继续使用 DSH 的工具与权限。
- **能力缺口**：记录未知工具与特定前置能力错误，按实际调用量、失败情况和参数形态进行每周检查。区分注册修复、工作流草稿和服务端实现任务。
- **工具与微信**：保留工具版本、草稿和启用状态；微信与桌面共用助手能力和数据。

| 层次 | 职责 |
| --- | --- |
| Host | 接入 DSH 全局会话事件、工作区、定时任务和微信 |
| Agent | 提供记忆上下文和助手工具，复用 DSH 模型与执行能力 |
| Storage Worker | 独立处理 SQLite 存储、事务、树结构与变更记录 |
| Client | 提供项目树、记忆、日历、任务、工具、日报和设置 |

插件在 DSH 运行期间工作，恢复运行后补处理到期任务。后台项目识别与记忆提炼分别记录进度，已提炼记忆的对话仍可补建项目；两者都由设置中的“自动维护”开关控制。普通会话与整理报告分开识别，避免报告内容反复生成记忆。DSH 工作区与插件项目分别管理，创建工作区不会直接生成项目。

## 数据与迁移

v2 使用新的数据库格式，旧库会在初始化前返回 `MIGRATION_REQUIRED`。迁移不会原地修改旧库，不会自动切换正式数据目录。

先禁用旧插件并等待正在执行的任务结束，再从仓库运行以下命令。两个路径必须为绝对路径，新目录必须不存在。

```sh
node plugins/dsh-personal-assistant/lib/migrate-v2.js \
  --source "/absolute/path/old-data" \
  --destination "/absolute/path/new-v2-data"
```

不导入旧数据时：

```sh
node plugins/dsh-personal-assistant/lib/migrate-v2.js \
  --fresh --destination "/absolute/path/new-v2-data"
```

迁移器生成 `legacy/v1.sqlite` 一致快照，校验完整性和校验和，在暂存目录导入项目、记忆、任务、日程、工具、来源及文件，然后原子落入新目录。`migration-report.json` 记录结果与待处理事项；旧归属冲突保持未归属，同名项目保留独立身份，含糊的旧别名交给后续处理。快照以只读文件保留。

迁移成功后，将 DSH 插件配置中的 `dataRoot` 指向新目录并重载插件。迁移命令只准备数据，不修改 DSH 配置。v2 目录可以继续从设置导出和切换。

DSH 自身的会话历史、模型账户和外部工具依赖由 DSH 管理；微信凭据在系统安全存储中，新设备需重新连接。同一数据目录只允许一个运行中的插件实例写入。

## 源码与本地构建

```sh
git clone https://github.com/McLinWxl/dsh-personal-assistant.git
cd dsh-personal-assistant
npm ci --prefix plugins/dsh-personal-assistant
npm run check
npm run build
npm exec --call="node --test checks/v2.mjs"
npm run check:package
mkdir -p dist
npm pack ./plugins/dsh-personal-assistant --ignore-scripts --pack-destination dist
```

将 `dist/` 中生成的 `.tgz` 文件添加到 DSH。

以下开发命令会同步到本机 DSH profile，切换到 v2 数据目录后再使用：

```sh
npm run dev        # 构建并同步到本机 DSH 配置目录中的插件副本
npm run dev:watch  # 监听 src/，改动后自动构建并同步
```

同步完成后，只改客户端界面时刷新页面即可看到效果；改动 host、agent 或 worker 时，在 DSH 插件页重载插件或重启 DSH。DSH 加载的是配置目录中的插件副本，仓库目录的改动不会自动生效。

| 目录 | 用途 |
| --- | --- |
| `plugins/dsh-personal-assistant/src/` | 插件业务源码 |
| `plugins/dsh-personal-assistant/scripts/` | 构建与安装包校验 |
| `scripts/`、`release/`、`.github/workflows/` | 发布配置和 GitHub 自动化流程 |
| `checks/v2.mjs` | 版本化的项目树、归属、迁移与能力治理回归检查 |
| `checks/live-ui.mjs` | 临时 DSH profile 的界面验证入口 |
| `test/` | 本地完整回归及历史原型测试，不提交 Git、不进入安装包 |
| `plugins/dsh-personal-assistant/lib/`、`dist/` | 自动生成的运行文件和安装包，不提交 Git |

公开仓库保留源码、构建与发布配置；安装包只包含明确列出的运行文件、插件元数据、README 和许可文件。构建时从根目录复制 README 与 LICENSE，并生成依赖许可声明，无需维护重复文档。版本标签触发三系统构建与安装包校验，通过后自动创建 GitHub Release。

## 许可证

[MIT](LICENSE)。安装包内的 `THIRD_PARTY_NOTICES.md` 收录依赖许可。
