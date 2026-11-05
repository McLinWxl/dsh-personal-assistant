import { schemas, type Actor, type Command } from './contracts.js';

export interface CommandDefinition {
  description: string;
  read: boolean;
  agent: boolean;
  maintenance: boolean;
  actors: Actor['kind'][];
}

const all: Actor['kind'][] = ['ui', 'model', 'maintenance', 'system'];
const owner: Actor['kind'][] = ['ui', 'system'];
const entry = (
  description: string,
  options: Partial<Omit<CommandDefinition, 'description'>> = {},
): CommandDefinition => ({
  description,
  read: false,
  agent: true,
  maintenance: false,
  actors: all,
  ...options,
});
const read = (description: string): CommandDefinition =>
  entry(description, { read: true, maintenance: true });
const internal = (description: string, readonly = false): CommandDefinition =>
  entry(description, { agent: false, actors: owner, read: readonly });

// Schema, audience, registration and documentation use this single exhaustive catalog.
export const commands: Record<Command, CommandDefinition> = {
  overview: internal('读取助手概览。', true),
  list: read('按类别、项目和关键词分页读取对象；项目筛选使用统一关系。'),
  searchAll: read('搜索记忆、项目、任务、日程、工具和实体。'),
  get: read('读取对象当前版本。'),
  relations: read('读取对象关联、唯一所属项目和可复用项目。'),
  settingsGet: internal('读取设置。', true),
  settingsSave: internal('保存设置。'),
  projectCreate: entry(
    '新建项目或子项目。模型需提供真实来源引用；明确要求可立即创建，否则须两个不同用户来源。parent=null 表示根项目。',
    { maintenance: true },
  ),
  projectEdit: entry('按当前版本更新项目属性，保留稳定 key 和场景身份。', { maintenance: true }),
  projectTree: read('读取项目树、稳定 key、路径和版本。'),
  projectRename: entry('重命名项目，保持 key 不变并保留旧名称别名。', { maintenance: true }),
  projectMove: entry('移动项目及整棵子树。传入源和目标父项目当前版本；服务端拒绝成环、超深和同父重名。', {
    maintenance: true,
  }),
  projectMerge: entry('原子合并两个项目，重定向成员与复用关系；不同场景身份或子项冲突将返回具体错误。', {
    maintenance: true,
  }),
  projectSplit: entry('将项目成员和直接子项目明确分配到多个新子项目；未选中的成员保持原归属。', {
    maintenance: true,
  }),
  projectArchive: entry('归档项目。未完成工作或未归档子项目会阻止执行；归档不会删除项目。', {
    maintenance: true,
  }),
  projectRestore: entry('恢复归档项目到指定状态。', { maintenance: true }),
  projectRemove: entry('真正删除空项目；返回全部阻塞项，不自动归档或删除其成员。', { maintenance: true }),
  projectAttach: entry('设置对象唯一归属 contains，或增加跨项目适用关系 applies_to。需对象和项目版本。', {
    maintenance: true,
  }),
  projectDetach: entry('解除一条归属或适用关系，不删除对象。', { maintenance: true }),
  projectAlias: entry('添加或移除全局唯一的项目别名。重复别名返回冲突对象。', { maintenance: true }),
  projectBind: entry('绑定或清除当前会话的默认项目，使用当前绑定版本。此操作不会新建子项目。'),
  projectBinding: read('读取当前会话默认项目及绑定版本。'),
  projectPreview: read('预览项目操作的树变化与阻塞项，不写入数据。'),
  projectDecisions: read('读取自动整理的未决、失败和已执行记录。'),
  memoryCapture: entry('提炼带真实来源引用的长期记忆，可原子设置项目归属。', { maintenance: true }),
  memoryEdit: entry('修正或固定记忆；正文修改保留人工措辞并使派生事实待刷新。'),
  memoryRefresh: entry('从当前人工正文刷新派生事实，不改正文。', { maintenance: true }),
  memoryClassify: entry('整理记忆分类，保留人工字段。', { maintenance: true }),
  memoryPrune: entry('清理无关联、无人工保护且低价值的过期记忆。', { maintenance: true }),
  memoryRemove: entry('删除指定记忆及其关系；原生会话仍由 DSH 管理。', { actors: ['ui', 'model', 'system'] }),
  memorySearch: read('检索相关记忆；外发和子任务使用 external。'),
  related: read('寻找适用于当前项目场景的可复用经验。'),
  associate: entry('将适用的记忆关联为 applies_to，保持原归属。'),
  consolidate: entry('归并等价记忆，保留引用、原始命题与关系。', { maintenance: true }),
  maintain: internal('运行确定性记忆整理。'),
  changes: read('分页读取变更记录。'),
  change: read('读取变更详情。'),
  reportWindow: internal('收集日报周期数据。', true),
  reportSave: internal('保存日报。'),
  reportRevise: internal('更新日报正文。'),
  reportConfirm: internal('标记日报已读。'),
  reportList: internal('读取日报列表。', true),
  reportGet: internal('读取日报及树变化。', true),
  snapshotTake: internal('生成数据库快照。'),
  snapshotPrune: internal('清理到期快照。'),
  remove: internal('删除指定业务对象，项目使用相同服务端删除检查。'),
  taskCreate: entry('创建任务；期限与日历时段分别记录。'),
  taskEdit: entry('更新任务；完成状态需真实结果或用户确认。'),
  eventCreate: entry('创建日历日程，时间带时区。'),
  eventEdit: entry('更新日历日程。'),
  eventOverride: entry('更新或取消重复日程的单次实例。'),
  calendar: read('读取指定时间范围的日历实例。'),
  icsImport: internal('导入日历。'),
  icsExport: internal('导出日历。', true),
  inbox: internal('读取通知。', true),
  inboxRead: internal('标记通知已读。'),
  toolSave: entry('保存工作流或脚本版本；模型新增能力生成草稿，不会新增服务端命令。', { maintenance: true }),
  toolActivate: internal('启用已保存工具版本。'),
  toolVersions: read('读取工具版本。'),
  sourceReview: entry('标记本轮来源为已提炼或普通内容。', { maintenance: true }),
  entitySave: entry('保存人物、地点、组织、物品和主题。'),
  link: entry('关联对象与实体；项目归属使用 projectAttach。'),
  capabilityGapReport: entry('记录缺失工具、前置能力或尚未实现的需求；使用具体目标和可复现上下文。', {
    maintenance: true,
  }),
  capabilityGaps: read('读取能力缺口与处理进度。'),
  capabilityGapUpdate: entry('更新缺口状态与处理结果；必须提供验证结果。', { maintenance: true }),
  capabilityProposal: entry('为能力缺口保存注册修复、工作流或服务端实现方案；工作流可链接 toolSave 草稿。', {
    maintenance: true,
  }),
  capabilityCatalog: read('读取插件命令、适用角色和模型可见性。'),
};

export function commandCatalog(): { name: Command; definition: CommandDefinition }[] {
  return (Object.keys(schemas) as Command[]).map((name) => ({ name, definition: commands[name] }));
}
