import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MemoryStore } from '../src/memory-store.mjs';
import { seed, localPort, START, memoryInput, projectInput } from '../src/fixtures.mjs';
import { runScenario } from '../src/scenario.mjs';
import { registerModelTools } from '../src/model-plugin.mjs';
import { validateContext } from '../src/context-schema.mjs';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'));
  let time = START; let active;
  const open = () => { active = new MemoryStore(root, { clock: () => time }); return active; };
  const store = open();
  t.after(() => { try { active.close(); } catch {} rmSync(root, { recursive: true, force: true }); });
  return { root, store, open, setTime: value => { time = value; } };
}

test('模型抽取必须复核当前版本，保留引用且不能将未知覆盖当成已验证', t => {
  const { store } = setup(t);
  const a = store.captureMemory({ ...memoryInput, coverage: 'model-extracted',
    observations: [{ sourceId: 'conversation-a', at: '2025-01-02', quote: '先准备副本' }] }, 'a').id;
  const b = store.captureMemory({ ...memoryInput, coverage: 'model-extracted',
    observations: [{ sourceId: 'conversation-b', at: '2026-01-02', quote: '提前留一份副本' }] }, 'b').id;
  assert.equal(store.maintain('unreviewed').groups, 0);
  const reviews = [a, b].map(id => ({ id, revision: store.get('nodes', id).revision }));
  assert.equal(store.planConsolidation({ reviews: reviews.slice(0, 1) }).groups.length, 0);
  const change = store.applyPlan(store.planConsolidation({ reviews }), 'reviewed');
  assert.equal(change.groups, 1);
  assert.deepEqual(store.get('nodes', a).data.observations.map(o => o.quote), ['先准备副本', '提前留一份副本']);
  assert.equal(store.get('nodes', a).data.coverage, 'model-extracted');
  store.undo(change.changeId, 'undo');
  assert.throws(() => store.planConsolidation({ reviews }), /STALE_REVIEW/);
});

test('模型批准仍不能越过事实、条件、来源引用和人工保护', t => {
  const { store } = setup(t);
  const cases = [
    [{ facts: [{ subject: 'A', predicate: '需要', value: '甲' }] }, { facts: [{ subject: 'A', predicate: '需要', value: '乙' }] }],
    [{ requirements: { venue: 'indoor' } }, { requirements: { venue: 'outdoor' } }],
    [{ observations: [{ sourceId: 'no-quote', at: '2025-01-01' }] }, {}],
    [{ pinned: true }, {}], [{ type: 'episode' }, {}],
  ];
  const reviews = [];
  cases.forEach(([a, b], i) => [a, b].forEach((extra, j) => {
    const id = store.captureMemory({ ...memoryInput, owner: 'pair-' + i, coverage: 'model-extracted',
      observations: [{ sourceId: 'source-' + i + j, at: '2025-01-01', quote: '待复核引用' }], ...extra }, i + '-' + j).id;
    reviews.push({ id, revision: store.get('nodes', id).revision });
  }));
  assert.equal(store.applyPlan(store.planConsolidation({ reviews }), 'reviewed').groups, 0);
  assert.equal(store.all('nodes').length, 10);
});

test('选择性关联只接纳当前且适用的候选，失败时不留下部分关系', t => {
  const { store } = setup(t), ids = seed(store);
  const p = store.createProject(projectInput, 'project').id;
  const version = id => ({ id, revision: store.get('nodes', id).revision });
  assert.throws(() => store.associateSelected(p, [version(ids.first), version(ids.foreign)], 'bad-owner'), /INAPPLICABLE_MEMORY/);
  assert.equal(store.all('edges').filter(e => e.data.from === p).length, 0);
  assert.throws(() => store.associateSelected(p, [{ id: ids.first, revision: 0 }], 'stale'), /STALE_VERSION/);
  const result = store.associateSelected(p, [version(ids.first), version(ids.exception)], 'selected');
  assert.equal(result.createdLinks, 2);
  assert.ok(!result.memoryIds.includes(ids.duplicate));
  assert.equal(store.associateSelected(p, [version(ids.first)], 'again').createdLinks, 0);
});

test('语义归并允许不同措辞，保存引用并在撤回时恢复各自命题', t => {
  const { store } = setup(t);
  const source = (body, facts, at) => ({ ...memoryInput, body, facts, coverage: 'model-extracted',
    observations: [{ sourceId: body, at, quote: body }] });
  const firstFacts = [{ subject: '出行', predicate: '携带', value: '纸质地址' }];
  const otherFacts = [{ subject: '旅行准备', predicate: '保存', value: '地址纸本' }];
  const a = store.captureMemory(source('出行随身带纸质地址', firstFacts, '2025-02-01'), 'a').id;
  const b = store.captureMemory(source('旅行时留一份地址纸本', otherFacts, '2026-02-01'), 'b').id;
  const proposal = { memories: [a, b].map(id => ({ id, revision: store.get('nodes', id).revision })),
    canonicalFacts: [{ subject: '旅行', predicate: '准备', value: '纸质地址副本' }] };
  assert.equal(store.planConsolidation({ reviews: proposal.memories }).groups.length, 0);
  const change = store.applyPlan(store.planSemanticConsolidation([proposal]), 'semantic');
  assert.deepEqual(store.get('nodes', a).data.facts, proposal.canonicalFacts);
  assert.equal(store.get('nodes', a).data.observations.length, 2);
  store.editMemory(a, { body: '用户保留的新版内容' }, store.get('nodes', a).revision, 'manual');
  store.undo(change.changeId, 'undo');
  assert.equal(store.get('nodes', a).data.body, '用户保留的新版内容');
  assert.deepEqual(store.get('nodes', a).data.facts, firstFacts);
  assert.deepEqual(store.get('nodes', b).data.facts, otherFacts);
  assert.throws(() => store.planSemanticConsolidation([proposal]), /STALE_REVIEW/);
});

test('语义计划仍拒绝跨所有者、跨条件、重叠组与并发人工改动', t => {
  const { store } = setup(t);
  const data = { ...memoryInput, coverage: 'model-extracted',
    observations: [{ sourceId: 'quote', at: '2025-01-01', quote: '记忆全文' }] };
  const a = store.captureMemory(data, 'a').id;
  const b = store.captureMemory(data, 'b').id;
  const c = store.captureMemory({ ...data, owner: 'someone-else' }, 'c').id;
  const d = store.captureMemory({ ...data, requirements: { venue: 'outdoor' } }, 'd').id;
  const group = ids => ({ memories: ids.map(id => ({ id, revision: store.get('nodes', id).revision })), canonicalFacts: data.facts });
  assert.throws(() => store.planSemanticConsolidation([group([a, c])]), /INCOMPATIBLE_CONTEXT/);
  assert.throws(() => store.planSemanticConsolidation([group([a, d])]), /INCOMPATIBLE_CONTEXT/);
  assert.throws(() => store.planSemanticConsolidation([group([a, b]), group([b, a])]), /OVERLAPPING_GROUP/);
  const plan = store.planSemanticConsolidation([group([a, b])]);
  store.editMemory(a, { notes: '后来编辑' }, store.get('nodes', a).revision, 'edit');
  assert.throws(() => store.applyPlan(plan, 'apply'), /STALE_PLAN/);
  assert.throws(() => store.planSemanticConsolidation([group([a, b])]), /PROTECTED_MEMORY/);
});

test('模型工具校验来源引用和已知条件，不接受模型指定所有者或覆盖等级', async t => {
  const { store, setTime } = setup(t);
  const project = store.createProject(projectInput, 'p').id;
  const registry = new Map(), audit = [];
  const scope = { owner: projectInput.owner, sessionId: 'isolated',
    source: { id: 'user-message', text: '室内活动签到先准备离线名单。' } };
  registerModelTools({ tools: { register: tool => registry.set(tool.name, tool) } }, x => x, store, scope, audit);
  const invoke = (name, args, callId) => registry.get(name).execute(args, { callId });
  const payload = { title: '签到准备', body: scope.source.text, type: 'method',
    facts: memoryInput.facts, topics: ['签到'], requirements: { venue: 'indoor' }, occurredAt: '2025-11-03' };
  await assert.rejects(invoke('memory_capture', { projectId: project, payload: JSON.stringify({ ...payload, owner: 'forged' }) }, 'owner'), /INVALID_PAYLOAD/);
  await assert.rejects(invoke('memory_capture', { projectId: project, payload: JSON.stringify({ ...payload, coverage: 'verified-structured' }) }, 'coverage'), /INVALID_PAYLOAD/);
  await assert.rejects(invoke('memory_capture', { projectId: project, payload: JSON.stringify({ ...payload, body: '用户没有说过的内容' }) }, 'quote'), /QUOTE_NOT_IN_CURRENT_MESSAGE/);
  await assert.rejects(invoke('memory_capture', { projectId: project, payload: JSON.stringify({ ...payload, requirements: { offlineList: true } }) }, 'condition'), /UNSUPPORTED_REQUIREMENT/);
  assert.equal(store.all('nodes').filter(n => n.kind === 'memory').length, 0);
  const args = { projectId: project, payload: JSON.stringify(payload) };
  const first = JSON.parse(await invoke('memory_capture', args, 'valid'));
  setTime(START + 10_000);
  assert.deepEqual(JSON.parse(await invoke('memory_capture', args, 'valid')), first);
  const saved = store.get('nodes', first.id);
  assert.equal(saved.data.coverage, 'model-extracted');
  assert.equal(saved.data.owner, scope.owner);
  assert.equal(saved.data.observations[0].sourceId, 'user-message');
  assert.equal(saved.data.observations[0].recordedAt, new Date(START).toISOString());
  assert.equal(store.all('edges').length, 1);
});

test('共享条件词表校验任意领域维度，拒绝同义字段和错误类型', () => {
  const schema = { coldChain: { type: 'boolean' }, transport: { type: 'string', values: ['rail', 'road'] },
    temperature: { type: 'number' } };
  assert.deepEqual(validateContext({ coldChain: true, transport: 'rail', temperature: 2 }, schema),
    { coldChain: true, transport: 'rail', temperature: 2 });
  assert.throws(() => validateContext({ 冷链: true }, schema), /CONTEXT_SCHEMA_MISMATCH/);
  assert.throws(() => validateContext({ coldChain: 'true' }, schema), /CONTEXT_SCHEMA_MISMATCH/);
  assert.throws(() => validateContext({ transport: 'train' }, schema), /CONTEXT_SCHEMA_MISMATCH/);
  assert.deepEqual(validateContext({}, schema), {});
});

test('完整链路：跨年度跨领域关联、整理、撤回并保留同字段及新增字段人工编辑', async t => {
  const { store, open } = setup(t);
  const ids = seed(store);
  const result = await runScenario(localPort(store), ids);
  assert.equal(result.passed, true);
  const before = store.inspect(); store.close();
  assert.deepEqual(open().inspect(), before);
});

test('撤回无交叉字段，同时保留后来新增的人工备注', t => {
  const { store } = setup(t); const ids = seed(store);
  const original = store.get('nodes', ids.first);
  const change = store.maintain('maintain');
  const current = store.get('nodes', ids.first);
  store.editMemory(ids.first, { notes: '另一字段上的人工修改' }, current.revision, 'edit');
  const result = store.undo(change.changeId, 'undo');
  assert.deepEqual(result.preserved, []);
  assert.equal(store.get('nodes', ids.first).data.body, original.data.body);
  assert.equal(store.get('nodes', ids.first).data.notes, '另一字段上的人工修改');
});

test('字段值改走又改回来仍属于人工编辑，不能只用值比较撤回', t => {
  const { store } = setup(t); const ids = seed(store);
  const change = store.maintain('maintain');
  const after = store.get('nodes', ids.first);
  store.editMemory(ids.first, { body: '暂时修改' }, after.revision, 'edit-1');
  store.editMemory(ids.first, { body: after.data.body }, store.get('nodes', ids.first).revision, 'edit-2');
  const undo = store.undo(change.changeId, 'undo');
  assert.ok(undo.preserved.some(p => p.field === 'body'));
  assert.equal(store.get('nodes', ids.first).data.body, after.data.body);
});

test('不同内容与对象 ID 的同字段编辑均被保留', t => {
  const { store } = setup(t);
  for (const [index, value] of ['电话确认', '不需要签到', '日本語と中文', '包含引号 " 和单引号 \''].entries()) {
    const data = { ...memoryInput, facts: [{ subject: `对象${index}`, predicate: '做法', value }] };
    const a = store.captureMemory(data, `capture-${index}-a`).id;
    store.captureMemory({ ...data, observations: [{ sourceId: `source-${index}`, at: '2025-12-01T00:00:00Z' }] }, `capture-${index}-b`);
    const change = store.maintain(`maintain-${index}`);
    const human = `用户实际选择：${value}`;
    store.editMemory(a, { body: human }, store.get('nodes', a).revision, `edit-${index}`);
    store.undo(change.changeId, `undo-${index}`);
    assert.equal(store.get('nodes', a).data.body, human);
  }
});

test('重复经历、不同适用条件、不同命题、固定和独特备注不被强行归并', t => {
  const { store } = setup(t);
  const cases = [
    [{ type: 'episode' }, {}], [{ pinned: true }, {}], [{ protected: true }, {}],
    [{ notes: '独特说明' }, {}], [{ coverage: 'unverified' }, {}],
    [{ requirements: { venue: 'outdoor' } }, { requirements: { venue: 'indoor' } }],
    [{ facts: [{ subject: 'A', predicate: '选择', value: '甲' }] }, { facts: [{ subject: 'A', predicate: '选择', value: '乙' }] }],
  ];
  for (const [i, [a, b]] of cases.entries()) {
    const owner = `owner-${i}`;
    store.captureMemory({ ...memoryInput, ...a, owner }, `a-${i}`);
    store.captureMemory({ ...memoryInput, ...b, owner }, `b-${i}`);
  }
  assert.equal(store.maintain('maintain').groups, 0);
  assert.equal(store.inspect().nodes.length, cases.length * 2);
});

test('新项目身份保持独立，旧时间保留，私密与他人记录先过滤再取候选', t => {
  const { store } = setup(t); const ids = seed(store);
  for (let i = 0; i < 20; i++) store.captureMemory({ ...memoryInput, visibility: 'private-only' }, `private-${i}`);
  const p = store.createProject(projectInput, 'new').id;
  const results = store.findRelated(p);
  assert.ok(results.some(r => r.id === ids.first));
  assert.ok(results.every(r => ![ids.unrelated, ids.privateMemory, ids.foreign, ids.expired].includes(r.id)));
  assert.equal(results.find(r => r.id === ids.first).observations[0].at, memoryInput.observations[0].at);
  assert.notEqual(p, ids.oldProject);
});

test('规划后发生对象编辑：整批拒绝，人工编辑不丢失', t => {
  const { store } = setup(t); const ids = seed(store);
  const plan = store.planConsolidation();
  store.editMemory(ids.first, { notes: '规划时还没有这条备注' }, store.get('nodes', ids.first).revision, 'edit');
  assert.throws(() => store.applyPlan(plan, 'apply'), { code: 'STALE_PLAN' });
  assert.ok(store.get('nodes', ids.duplicate));
  assert.equal(store.inspect().rollbackItems, 0);
  assert.equal(store.inspect().outbox.length, 0);
});

test('规划后新增引用：识别关系集合变化，不能留下悬空边', t => {
  const { store } = setup(t); const ids = seed(store);
  const plan = store.planConsolidation();
  const project = store.createProject(projectInput, 'new').id;
  store.link(project, ids.duplicate, 'reuses_method', 'late-link');
  assert.throws(() => store.applyPlan(plan, 'apply'), { code: 'STALE_GRAPH' });
  assert.equal(store.inspect().foreignKeyErrors, 0);
});

test('多组同时归并，组间关系也统一重连且可撤回', t => {
  const { store } = setup(t); const ids = seed(store);
  const data = { ...memoryInput, facts: [{ subject: '设备', predicate: '检查', value: '电量' }] };
  const a = store.captureMemory(data, 'second-a').id;
  const b = store.captureMemory({ ...data, observations: [{ sourceId: 'second-b', at: '2025-12-01T00:00:00Z' }] }, 'second-b').id;
  const edge = store.link(ids.duplicate, b, 'related', 'cross-group').id;
  const before = store.inspect().edges.map(e => ({ id: e.id, data: e.data }));
  const change = store.maintain('maintain');
  assert.equal(change.groups, 2);
  assert.equal(store.get('edges', edge).data.from, ids.first);
  assert.equal(store.get('edges', edge).data.to, a);
  store.undo(change.changeId, 'undo');
  assert.deepEqual(store.inspect().edges.map(e => ({ id: e.id, data: e.data })), before);
});

test('同一请求重复执行与重启重放只产生一个项目、变化包和通知', t => {
  const { store, open } = setup(t); seed(store);
  const project = store.createProject(projectInput, 'new');
  assert.deepEqual(store.createProject(projectInput, 'new'), project);
  assert.throws(() => store.createProject({ ...projectInput, title: '不同请求' }, 'new'), { code: 'REQUEST_KEY_REUSED' });
  const change = store.maintain('maintain'); store.close();
  const reopened = open();
  assert.deepEqual(reopened.maintain('maintain'), change);
  assert.equal(reopened.inspect().outbox.length, 1);
});

test('整理中途异常：数据、关系、恢复资料和发件箱一起回滚', t => {
  const { store } = setup(t); seed(store);
  const before = store.inspect();
  store.fault = stage => { if (stage === 'after-mutation') throw new Error('injected-failure'); };
  assert.throws(() => store.maintain('maintain'), /injected-failure/);
  assert.deepEqual(store.inspect(), before);
  store.fault = () => {};
  assert.equal(store.maintain('maintain').groups, 1);
});

for (const stage of ['after-mutation', 'before-commit', 'after-commit']) {
  test(`真实子进程退出恢复：${stage}`, t => {
    const { root, store, open } = setup(t); seed(store); store.close();
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./crash-worker.mjs', import.meta.url)), root, stage],
      { env: process.env, encoding: 'utf8' });
    assert.equal(child.status, 73, child.stderr);
    const reopened = open();
    assert.equal(reopened.inspect().integrity, 'ok');
    assert.equal(reopened.inspect().outbox.length, stage === 'after-commit' ? 1 : 0);
    const result = reopened.maintain('crash-maintenance');
    assert.equal(result.groups, 1);
    assert.equal(reopened.inspect().changes.length, 1);
    assert.equal(reopened.inspect().outbox.length, 1);
    assert.equal(reopened.inspect().foreignKeyErrors, 0);
  });
}

test('撤回后再次自动维护不立刻重做用户撤回的归并', t => {
  const { store } = setup(t); const ids = seed(store);
  const change = store.maintain('maintain');
  store.undo(change.changeId, 'undo');
  assert.equal(store.maintain('next-day').groups, 0);
  assert.ok(store.get('nodes', ids.duplicate));
});

test('72 小时截止前可读，到期即不可读，重启清理且时钟回拨不延长', t => {
  const { store, setTime, open } = setup(t); seed(store);
  const change = store.maintain('maintain');
  setTime(change.expiresAt - 1); assert.ok(store.rollbackItems(change.changeId).length > 0);
  setTime(change.expiresAt); assert.throws(() => store.rollbackItems(change.changeId), { code: 'UNDO_EXPIRED' });
  setTime(START); assert.throws(() => store.rollbackItems(change.changeId), { code: 'UNDO_EXPIRED' });
  store.close();
  const reopened = open();
  assert.equal(reopened.inspect().rollbackItems, 0);
  assert.equal(reopened.change(change.changeId).status, 'expired');
  assert.throws(() => reopened.undo(change.changeId, 'undo'), { code: 'UNDO_EXPIRED' });
});

test('配置为 1 小时的恢复期独立生效，已有批次保持原截止时间', t => {
  const { store, root } = setup(t); seed(store);
  const first = store.maintain('maintain'); store.close();
  const altered = new MemoryStore(root, { clock: () => START, retentionHours: 1 });
  try {
    assert.equal(altered.change(first.changeId).expiresAt, START + 72 * 3_600_000);
    const data = { ...memoryInput, facts: [{ subject: '新事项', predicate: '备用', value: '清单' }] };
    altered.captureMemory(data, 'short-a'); altered.captureMemory(data, 'short-b');
    assert.equal(altered.maintain('short').expiresAt, START + 3_600_000);
  } finally { altered.close(); }
});

test('停止后复制目录，可继续撤回并保留复制前的人工编辑', t => {
  const { store, root } = setup(t); const ids = seed(store);
  const change = store.maintain('maintain');
  store.editMemory(ids.first, { body: '搬移之前的人工修改' }, store.get('nodes', ids.first).revision, 'edit');
  store.close();
  const destination = mkdtempSync(join(tmpdir(), 'dsh-memory-copy-'));
  try {
    cpSync(root, destination, { recursive: true });
    const moved = new MemoryStore(destination, { clock: () => START + 3_600_000 });
    try {
      moved.undo(change.changeId, 'undo-after-copy');
      assert.equal(moved.get('nodes', ids.first).data.body, '搬移之前的人工修改');
      assert.ok(moved.get('nodes', ids.duplicate));
      assert.equal(moved.inspect().foreignKeyErrors, 0);
    } finally { moved.close(); }
  } finally { rmSync(destination, { recursive: true, force: true }); }
});

test('较旧的人工作业不能覆盖更新版本，也不能编辑不可写的所有者字段', t => {
  const { store } = setup(t); const ids = seed(store); const old = store.get('nodes', ids.first);
  store.editMemory(ids.first, { notes: '第一次修改' }, old.revision, 'edit-a');
  assert.throws(() => store.editMemory(ids.first, { notes: '过期修改' }, old.revision, 'edit-b'), { code: 'STALE_VERSION' });
  assert.throws(() => store.editMemory(ids.first, { owner: 'someone-else' }, old.revision, 'edit-c'), { code: 'INVALID_PATCH' });
});

test('撤回保留整理后新增的项目引用', t => {
  const { store } = setup(t); const ids = seed(store);
  const change = store.maintain('maintain');
  const newProject = store.createProject(projectInput, 'new-project').id;
  const newEdge = store.link(newProject, ids.first, 'reuses_method', 'new-edge').id;
  store.undo(change.changeId, 'undo');
  assert.equal(store.get('edges', newEdge).data.to, ids.first);
  assert.ok(store.get('nodes', ids.duplicate));
  assert.equal(store.inspect().foreignKeyErrors, 0);
});

test('撤回所需的项目已被后续删除：整组拒绝恢复，当前数据不被部分改写', t => {
  const { store } = setup(t); const ids = seed(store);
  const change = store.maintain('maintain');
  store.command('later-project-delete', { id: ids.oldProject }, () => {
    for (const edge of store.all('edges').filter(e => e.data.from === ids.oldProject)) store.put('edges', edge.id, 'edge', null);
    store.put('nodes', ids.oldProject, 'project', null); return { deleted: true };
  });
  const before = store.inspect();
  assert.throws(() => store.undo(change.changeId, 'undo'), { code: 'UNDO_DEPENDENCY_CONFLICT' });
  assert.deepEqual(store.inspect(), before);
});

test('时间排序按实际瞬时处理，拒绝无效或倒置的有效区间', t => {
  const { store } = setup(t);
  const a = store.captureMemory({ ...memoryInput, observations: [{ sourceId: 'a', at: '2025-11-03T09:00:00+09:00' }] }, 'a').id;
  const b = store.captureMemory({ ...memoryInput, observations: [{ sourceId: 'b', at: '2025-11-03T08:30:00+08:00' }] }, 'b').id;
  store.maintain('maintain');
  assert.ok(store.get('nodes', a)); assert.equal(store.get('nodes', b), null);
  assert.throws(() => store.captureMemory({ ...memoryInput, validTo: 'invalid-date' }, 'invalid'), { code: 'INVALID_TIME' });
  assert.throws(() => store.captureMemory({ ...memoryInput, validFrom: '2026-01-01', validTo: '2025-01-01' }, 'reversed'), { code: 'INVALID_TIME_RANGE' });
});

test('仅共享中文虚词不应自动建立项目关联', t => {
  const { store } = setup(t);
  const id = store.captureMemory({ ...memoryInput, title: '的，了，是', body: '的；了；是', topics: [], requirements: {} }, 'noise').id;
  const project = store.createProject(projectInput, 'project').id;
  assert.ok(!store.findRelated(project).some(r => r.id === id));
});
