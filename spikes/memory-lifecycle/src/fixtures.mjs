// All records are synthetic. Dates deliberately span one year; the engine never special-cases them.
export const START = Date.parse('2026-11-03T08:00:00+08:00');
export const OWNER = 'synthetic-person';
export const projectInput = {
  owner: OWNER, title: '家人的周末聚会', goal: '组织室内活动，准备签到与到场名单',
  domains: ['生活', '家庭'], topics: ['签到', '活动'], context: { venue: 'indoor', checkIn: true },
};
export const memoryInput = {
  owner: OWNER, type: 'method', title: '活动签到准备', body: '活动网络故障时，预先导出的离线名单避免了签到中断。',
  facts: [{ subject: '活动签到', predicate: '准备', value: '离线名单' }],
  observations: [{ sourceId: 'workshop-2025-result', at: '2025-11-03T09:00:00+08:00' }],
  topics: ['活动', '签到', '网络'], requirements: { venue: 'indoor', checkIn: true },
  coverage: 'verified-structured',
};

export function seed(store) {
  const oldProject = store.createProject({ owner: OWNER, title: '去年的开发者交流日',
    goal: '技术交流', domains: ['工作'], topics: ['活动'], context: {}, status: 'archived' }, 'seed-old-project').id;
  const first = store.captureMemory(memoryInput, 'seed-first').id;
  const duplicate = store.captureMemory({ ...memoryInput, title: '到场流程备用方案',
    body: '签到前准备离线名单，断网时也可以使用。',
    observations: [{ sourceId: 'workshop-2025-review', at: '2025-11-04T09:00:00+08:00' }] }, 'seed-duplicate').id;
  const exception = store.captureMemory({ ...memoryInput, title: '同一活动的不同问题',
    body: '离线名单中重名人员仍然需要人工核对。',
    facts: [{ subject: '重名签到', predicate: '需要', value: '人工核对' }],
    observations: [{ sourceId: 'workshop-2025-exception', at: '2025-11-03T09:30:00+08:00' }] }, 'seed-exception').id;
  const unrelated = store.captureMemory({ ...memoryInput, title: '家庭聚会', body: '记录山地徒步路线的坡度。',
    topics: ['徒步'], requirements: { venue: 'outdoor' },
    facts: [{ subject: '路线', predicate: '路面', value: '碎石' }] }, 'seed-unrelated').id;
  const expired = store.captureMemory({ ...memoryInput, title: '旧场地签到设备报价',
    validTo: '2026-01-01T00:00:00+08:00', facts: [{ subject: '设备', predicate: '价格', value: '500元' }] }, 'seed-expired').id;
  const privateMemory = store.captureMemory({ ...memoryInput, visibility: 'private-only',
    facts: [{ subject: '私人安排', predicate: '需要', value: '保密' }] }, 'seed-private').id;
  const foreign = store.captureMemory({ ...memoryInput, owner: 'another-synthetic-person' }, 'seed-foreign').id;
  const oldLink = store.link(oldProject, first, 'learned_from', 'seed-link-first').id;
  const duplicateLink = store.link(oldProject, duplicate, 'learned_from', 'seed-link-duplicate').id;
  return { oldProject, first, duplicate, exception, unrelated, expired, privateMemory, foreign, oldLink, duplicateLink };
}

export function localPort(store) {
  return {
    createProject: (data, key) => store.createProject(data, key),
    findRelated: id => store.findRelated(id),
    associate: (id, key) => store.associate(id, key),
    maintain: key => store.maintain(key),
    getMemory: id => store.get('nodes', id),
    edit: (id, patch, revision, key) => store.editMemory(id, patch, revision, key),
    undo: (id, key) => store.undo(id, key),
    inspect: () => store.inspect(),
  };
}
