import assert from 'node:assert/strict';
import { projectInput } from './fixtures.mjs';

// The same scenario runs directly against SQLite and through the actual DSH tool registry.
export async function runScenario(port, ids) {
  const stages = [];
  const project = await port.createProject(projectInput, 'scenario-project');
  assert.notEqual(project.id, ids.oldProject);
  stages.push({ step: 'create-project', newProjectId: project.id, oldProjectId: ids.oldProject });

  const related = await port.findRelated(project.id);
  const selected = related.map(x => x.id);
  for (const id of [ids.first, ids.duplicate, ids.exception]) assert.ok(selected.includes(id));
  for (const id of [ids.unrelated, ids.expired, ids.privateMemory, ids.foreign]) assert.ok(!selected.includes(id));
  const associated = await port.associate(project.id, 'scenario-associate');
  assert.equal(associated.createdLinks, 3);
  const before = await port.inspect();
  stages.push({ step: 'associate-year-old-experience', selected: related, excluded: 4,
    associated, projectCount: before.nodes.filter(n => n.kind === 'project').length });

  const maintenance = await port.maintain('scenario-maintenance');
  assert.equal(maintenance.groups, 1);
  assert.equal(await port.getMemory(ids.duplicate), null);
  const consolidated = await port.getMemory(ids.first);
  assert.equal(consolidated.data.observations.length, 2);
  assert.ok(await port.getMemory(ids.exception));
  const compacted = await port.inspect();
  assert.equal(compacted.edges.filter(e => e.data.from === project.id && e.data.to === ids.first).length, 1);
  assert.equal(compacted.foreignKeyErrors, 0);
  stages.push({ step: 'automatic-consolidation', ...maintenance,
    survivors: [ids.first, ids.exception], retainedObservationCount: 2,
    memoryCount: compacted.nodes.filter(n => n.kind === 'memory').length });

  const humanBody = '家庭聚会采用纸质名单，同时保留电子名单；重名由现场人员核对。';
  const humanNotes = '这是我在整理之后补充的本次安排。';
  await port.edit(ids.first, { body: humanBody, notes: humanNotes }, consolidated.revision, 'scenario-edit');
  stages.push({ step: 'manual-edit', changedFields: ['body', 'notes'] });

  const undo = await port.undo(maintenance.changeId, 'scenario-undo');
  const restored = await port.getMemory(ids.first);
  assert.equal(restored.data.body, humanBody);
  assert.equal(restored.data.notes, humanNotes);
  assert.equal(restored.data.observations.length, 1);
  assert.ok(await port.getMemory(ids.duplicate));
  assert.ok(undo.preserved.some(p => p.id === ids.first && p.field === 'body'));
  const after = await port.inspect();
  assert.deepEqual(after.edges.map(e => ({ id: e.id, data: e.data })), before.edges.map(e => ({ id: e.id, data: e.data })));
  assert.equal(after.integrity, 'ok'); assert.equal(after.foreignKeyErrors, 0);
  assert.equal(after.outbox.length, 2);
  assert.deepEqual(await port.undo(maintenance.changeId, 'scenario-undo-again'), undo);
  assert.equal((await port.inspect()).outbox.length, 2);
  assert.equal((await port.maintain('scenario-next-maintenance')).groups, 0);
  stages.push({ step: 'undo-preserving-human-edits', ...undo,
    body: restored.data.body, notes: restored.data.notes, relationsRestored: after.edges.length,
    notifications: after.outbox.map(e => e.type), integrity: after.integrity });
  return { passed: true, stages };
}
