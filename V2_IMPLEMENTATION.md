# 项目树与能力治理 v2

本轮已完成源码重构，版本保持 `0.1.0-alpha.8`。项目结构和归属调整自动执行，日报记录实际结果；资料不足和执行失败保留独立记录。没有提交、打标签、推送或同步正式 DSH profile。

## 实现

| 部分 | 文件 | 结果 |
| --- | --- | --- |
| 数据契约 | `src/domain/contracts.ts`、`project-types.ts` | 四层单亲树、稳定 key、版本引用、场景条件、结构化错误 |
| 命令目录 | `src/domain/commands.ts`、`src/host/agent.ts` | schema、角色、模型可见性和说明集中维护 |
| 项目存储 | `src/storage/schema-v2.ts`、`project-tree.ts` | 项目正文独立存储；唯一归属、多项适用关系；路径与深度服务端派生 |
| 既有消费者 | `src/storage/store.ts`、`memory-base.mjs`、`src/domain/calendar.ts` | 记忆、任务、日历、工具、检索、合并和删除统一使用 links |
| 自动识别 | `src/domain/projects.ts`、`src/storage/projects.ts`、`src/host/project-lifecycle.ts` | 持久化会话绑定、多事项识别、来源去重、子树优先检索、未决重试 |
| 自动整理 | `src/host/service.ts`、`src/storage/worker.ts` | structure / membership 阶段；计划版本校验、批次幂等、失败隔离 |
| 能力治理 | `src/storage/capabilities.ts`、`src/host/agent.ts` | 未知工具与特定前置能力错误记录；参数形态统计；每周分类提案 |
| 界面 | `src/client/projects.tsx`、`index.tsx`、`style.css` | 项目树、拖拽、移动、合并预览、拆分、归档恢复、阻塞详情、日报变化 |
| 迁移 | `src/storage/migrate-v2.ts`、`src/cli/migrate-v2.ts`、`src/storage/files.ts` | 旧库启动前拒绝、快照导入、新库初始化、原子落入新目录 |
| 安装包 | `scripts/build.mjs`、`scripts/verify-package.mjs`、`package.json` | 打包迁移 CLI；隔离 worker 与已打包 CLI 冒烟验证 |

以上 `src/`、`scripts/` 和 `package.json` 路径相对于 `plugins/dsh-personal-assistant/`。

## 命令覆盖

以下公开命令均具备契约、存储执行路径与模型注册。只读命令与内部操作通过同一目录区分。

| 命令 | schema | storage / worker | agent | 客户端 |
| --- | --- | --- | --- | --- |
| projectCreate / projectEdit / projectRename | ✓ | ✓ | ✓ | 创建、编辑 |
| projectTree | ✓ | ✓ | ✓ | 项目树与项目选择器 |
| projectMove | ✓ | ✓ | ✓ | 拖拽与目标选择 |
| projectMerge / projectPreview | ✓ | ✓ | ✓ | 预览、合并 |
| projectSplit | ✓ | ✓ | ✓ | 明确分配成员和直接子项目 |
| projectArchive / projectRestore / projectRemove | ✓ | ✓ | ✓ | 归档、恢复、删除及阻塞详情 |
| projectAttach / projectDetach | ✓ | ✓ | ✓ | 对象编辑归属、解除关联 |
| projectAlias | ✓ | ✓ | ✓ | 别名增删 |
| projectBind / projectBinding | ✓ | ✓ | ✓ | 会话自动绑定；无独立设置页 |
| projectDecisions | ✓ | ✓ | ✓ | 日报未决及失败事项 |
| capabilityGapReport / capabilityGaps | ✓ | ✓ | ✓ | 日报能力缺口 |
| capabilityGapUpdate / capabilityProposal / capabilityCatalog | ✓ | ✓ | ✓ | 日报状态与提案详情 |

`assistant_projectResolve` 是宿主工具，编排来源识别与经验选择。`projectInspect`、`projectApply`、`projectMaintenanceApply`、`capabilityObserve` 等 RPC 保持内部使用。

## 一致性

- `nodes` 保留统一对象身份，项目正文仅存于 `projects`；返回对象上的顶层 `projectId` 是从 links 计算的读取投影，命令中的 `projectId` 是输入参数。
- `links` 的主键为对象、项目、角色三元组，部分唯一索引保证每个对象仅有一条 `contains`。
- 根项目和非根兄弟分别校验归一化标题唯一，全局 key 与归一化别名分别唯一。
- 移动校验整棵子树；合并遇到子项重名不会递归猜测合并；拆分采用显式分配。
- 项目版本覆盖子树和成员变化，旧计划会失效。同一串行批次只接纳该批次自身造成的版本变化，不能覆盖外部的过期输入。
- 嵌套命令使用保存点；单项失败完整回滚，成功项及失败记录一起提交。重复请求返回已有结果。
- 自动创建验证用户来源和引用，重复文本不算第二个独立来源。会话绑定不自动充当新项目父节点。
- 自动归档同时检查不活动时间、子项目、未完成任务和未来日程；近期没有新资料的结构调整不会反复执行。
- 日报时间窗口以此前报告结束时间推进，不随“标记已读”的时间改变；周期记录不受列表分页数量截断。
- 生产路径不再读取旧 `data.projectId`、`belongs_to`、`reuses_method`；这些名称仅用于一次性导入旧库。

## 迁移与启用

可复制的迁移命令见 [README](README.md#数据与迁移)。先停止旧插件，再指定旧目录和一个尚不存在的新目录。迁移器不会修改 DSH 的 `dataRoot`。

导入覆盖项目、记忆、任务、日程、工具、来源、工具版本和调用历史、任务运行记录、报告、会话索引、设置及数据目录文件。运行中的任务转为待核对状态，避免重复执行。历史撤回记录不导入；原始数据库留存在只读快照中。

旧字段与边的归属冲突会保留为未归属；不同项目的重名保留独立身份；含糊别名记录为未决事项。结果写入 `migration-report.json`。随后将插件配置的 `dataRoot` 指向新目录并重载。

## 验证

- `npm run check`：通过。
- `npm run build`：通过。
- `npm exec --call="node test/run.mjs"`：133 项通过，0 失败，0 跳过。
- 其中版本化的 `checks/v2.mjs` 包含 35 项项目树、事务、归属、自动整理、能力治理、报告和临时库迁移检查。
- `npm run check:package`：安装包内隔离 worker 和迁移 CLI 通过，包含 14 个文件。
- 实际 DSH Web GUI：项目树、搜索、创建、场景编辑、删除阻塞、成环拒绝、移动后代层级、拖拽、合并预览及执行、归档恢复、窄屏布局、日报项目变化和能力缺口经过操作检查。
- 390 / 670 / 800 像素窗口核对了项目页的横向溢出；布局按插件内容区宽度切换单双栏。

原始输出存于 `output/validation/`，浏览器截图存于 `output/playwright/`。全部数据验证使用临时目录。

本轮没有调用真实模型账户；自动判定与模型失败重试通过可控模型输出验证。没有执行用户真实数据库导入，也没有进行正式 profile 切换、微信实发或跨平台发布验证。

## 后续发布

建议下一版使用 `0.1.0-alpha.9`，由发布负责人决定。发布说明应明确 v2 数据格式、一次性迁移命令、自动结构整理和项目树操作。先在隔离环境连接模型验收连续会话，再选择并切换数据目录，最后执行完整发布流程。
