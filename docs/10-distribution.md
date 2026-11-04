# GitHub 同步与插件发布

更新日期：2026-11-04。公开仓库为 [McLinWxl/dsh-personal-assistant](https://github.com/McLinWxl/dsh-personal-assistant)。

## 1. 已确定的交付方式

源码、产品设计、实现计划和合成测试场景同步到公开仓库。日常完成修改和验证后提交、推送；GitHub Actions 对 `main` 和 Pull Request 执行测试。自动同步以完成的 Git 提交为单位，不监视或上传未提交的本地文件。

正式插件通过 GitHub Release 的 `.tgz` 包分发，不要求使用者克隆仓库或本地编译。GitHub 仓库不是插件数据目录，个人记忆、会话、账号凭据、任务附件和数据库不会进入版本库。现阶段的本机环境清单单独留在工作目录。

公开仓库已创建；安装包尚未发布。`release/config.json` 中 `releaseEnabled` 保持 `false`，正式 bundle 已生成并完成本机实际安装，新的三系统 CI 与发行资产仍待验证。

## 2. DSH 安装入口

已读取 DSH 0.2.1-rc.5 的 `@deepseek-ai/dsh-plugin-manager/lib/types/install-spec.js`，并直接调用其 `parseInstallSpec` 核对地址格式：

| 输入 | 解析结果 | 本项目采用方式 |
|---|---|---|
| GitHub 仓库地址 | `git` | 开发源码入口；当前根目录不是安装包 |
| HTTPS `.tgz` 地址 | `tarball` | 正式安装入口 |
| GitHub Releases 列表页 | 拒绝 | 供浏览版本，不粘贴到安装输入框 |

DSH 插件管理页的“添加插件”支持“包名或地址”。发布后复制版本包链接到该输入框即可进入宿主安装流程。地址格式与本地 tgz 的安装、启用、卸载重装已验证；HTTPS 发行资产下载在发布后核对。

计划的版本链接格式如下；它们目前只是发布约定，不代表文件已经存在：

```text
https://github.com/McLinWxl/dsh-personal-assistant/releases/download/v<版本号>/dsh-personal-assistant.tgz
```

稳定版入口约定为：

```text
https://github.com/McLinWxl/dsh-personal-assistant/releases/latest/download/dsh-personal-assistant.tgz
```

安装说明优先展示带版本号的地址，便于复现和回退。预发布版本不更新稳定版入口。通过固定版本链接安装后，宿主是否自动发现后续 Release 需要单独验证；首版至少支持用户选择新版本链接升级。发布工作流不会改动用户已安装的插件。

## 3. 工程结构

```text
.github/workflows/ci.yml        主分支和 PR 的三个系统测试
.github/workflows/release.yml   版本标签触发验收、打包和 Release
release/config.json            仓库、正式包目录、资产名称与发布开关
scripts/release-config.mjs      元数据、路径、版本和发布状态检查
scripts/pack-release.mjs        npm pack、包内容清单与 SHA-256
scripts/publish-release.mjs     上传完整草稿后公开 Release
test/release.test.mjs           发布保护和真实打包回归测试
plugins/dsh-personal-assistant/ 正式插件源码与构建产物目录
spikes/memory-lifecycle/        独立验证代码，不作为正式插件发布
```

正式包声明 `engines.dsh`、`dsh.bundle.patch`、Host 入口、Client 入口（有界面时）、许可证及明确的 `files` 清单，提交依赖锁文件。`build` 产出发布文件；`test` 验证实现；`test:package` 必须接收打包文件路径并在隔离环境验证实际包。正式包不得引用 `spikes/` 或开发机绝对路径。

## 4. 自动化执行顺序

1. 修改代码、文档和测试，执行受影响检查；完成后同步 GitHub。
2. CI 在 Windows、macOS、Linux 运行根目录测试。并对正式包执行依赖安装、类型检查、构建、37 项业务测试和独立打包检查；它们不会调用模型，也不等同于三个系统的 DSH 原生界面验收。
3. 达到发布条件后更新正式包版本、兼容范围和迁移说明，推送对应 `vX.Y.Z` 标签。
4. Release 工作流校验版本、公开包属性、许可证和目录，然后安装锁定依赖、构建、测试、打包；三个系统都对包执行 `test:package`。
5. 全部成功后，发布任务重建包并再验收，生成 `.tgz`、`SHA256SUMS` 和 `release.json`。元数据记录版本、兼容范围、提交 SHA、文件清单及包校验值。
6. 使用当前仓库的 `GITHUB_TOKEN` 建立草稿并上传三项资产，完成后公开。预发布单独标记，同版本资产不自动覆盖。上传失败时保留草稿供检查，不发布不完整版本。

普通 CI 仅有 `contents: read`；发布任务使用 `contents: write`。第三方 Action 固定提交 SHA。凭据不写入仓库，不需要另存长期个人访问令牌。[GitHub Actions 包发布文档](https://docs.github.com/en/actions/tutorials/publish-packages)、[GitHub CLI Release 命令](https://cli.github.com/manual/gh_release_create)。

## 5. 首个公开版本的完成条件

- 完整 Host/Client bundle 可从 `.tgz` 安装、启用、停用、卸载与重新安装；卸载保留业务目录。
- 三个系统真实 DSH 验证安装、对话、日历、整理撤回、数据目录选择和迁移；标明实际测过的宿主版本与架构。
- 先修复已发现的摘要用途遗漏和时区展示，再完成独立记忆质量评测。
- 升级前做格式兼容检查；失败时保留当前数据。降级遇到新格式时明确拒绝打开，不能直接用旧程序读取新库。
- 包文件清单不包含凭据、个人资料、数据库、临时会话或测试报告；运行时依赖随正式包可解析。
- 已采用 MIT，保留依赖许可证；发布说明列出实际实现能力、迁移方式和兼容版本。

发布流程先搭建，正式版达到这些条件后再启用。当前没有预造版本标签、发布空包或宣称七项能力已完成。

## 6. 本轮验证记录

- 已创建指定公开仓库，开发代码和文档已同步至提交 `82ab4b363946f8d548904af98f5ff1c685a13c4a`。
- 本机 37 项测试通过：30 项记忆链路测试、7 项发布检查与真实 npm 打包测试。
- 测试包的文件清单、SHA-256 和版本地址元数据一致；它仅在临时测试目录生成，未作为产品发布。
- 当前 `release:check` 按预期拒绝未启用发布的工程。
- 真实宿主解析器接受版本化与稳定版 `.tgz` 地址，拒绝 Releases 列表页；这只验证输入解析，不代表尚不存在的文件可下载。
- 2026-11-04 09:44（Asia/Shanghai），上述提交的 [首次 CI](https://github.com/McLinWxl/dsh-personal-assistant/actions/runs/41756059955) 全部成功。三个系统均使用 Node.js 24.21.0、npm 11.19.0；逐项日志确认各 37 项测试通过，失败和跳过均为 0。

| GitHub Runner | 通过 | 失败 | 跳过 | 运行记录 |
|---|---:|---:|---:|---|
| Windows | 37 | 0 | 0 | [test (windows-latest)](https://github.com/McLinWxl/dsh-personal-assistant/actions/runs/41756059955/job/126332325836) |
| Ubuntu / Linux | 37 | 0 | 0 | [test (ubuntu-latest)](https://github.com/McLinWxl/dsh-personal-assistant/actions/runs/41756059955/job/126332326126) |
| macOS | 37 | 0 | 0 | [test (macos-latest)](https://github.com/McLinWxl/dsh-personal-assistant/actions/runs/41756059955/job/126332326428) |

本次执行覆盖记忆领域逻辑、真实子进程中断恢复、目录复制、发布条件校验与临时 npm 包生成。上述历史 CI 不代表当前正式包。正式 bundle 现已在本机完成 tgz 安装、启动、卸载重装，业务目录保留；37 项正式测试在 Node 25.2.1 与 DSH 自带 Node 24.21.0 通过。当前公开发行资产尚未生成。后续文档更新不改变上述历史被测代码提交。
