import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startDsh } from '../src/dsh-runtime.mjs';
import { MemoryStore } from '../src/memory-store.mjs';
import { registerModelTools, assistantPersona, reviewerPersona } from '../src/model-plugin.mjs';
import { saveReport, sourceHashes } from './report.mjs';

const root = mkdtempSync(join(tmpdir(), 'dsh-memory-live-'));
const store = new MemoryStore(join(root, 'memory'));
const audit = [], events = [], stages = [], turns = [], handles = new Set();
const provider = 'deepseek-account', model = process.env.DSH_MODEL ?? 'deepseek-flash';
const reasoningEffort = process.env.DSH_REASONING_EFFORT ?? 'high';
const report = { mode: 'installed-dsh-agent-loop-and-live-model', provider, model, reasoningEffort,
  syntheticData: true, sourceHashes: sourceHashes(), audit, events, stages, turns, passed: false };
let runtime;
const humanBody = '这次家庭聚会使用纸质签到表，电子离线名单作为备用；重名必须由现场人员核对。';
const humanNotes = '这是整理之后由我补充的安排，请保留。';
const historicalPrompt = [
  '请把旧资料补录到助手：新建一个工作项目“2025 开发者交流日”，已完成，室内活动，需要签到。',
  '2025 年 11 月 3 日的复盘写道：“室内活动签到前准备离线名单，可以在断网时继续核对来宾。”',
  '2025 年 11 月 4 日的补充复盘写道：“举办室内活动时，提前备好离线来宾名单，网络中断也能继续签到。”',
  '当天还发现另一件事：“室内活动签到时，离线名单中的重名人员仍然需要人工核对。”',
  '把这三条分别提炼为可以长期使用的经验，关联这个旧项目，保留各自的发生日期。前两条说的是同一做法，最后一条是独立的例外处理。先不要整理合并。',
].join('\n');
const newPrompt = [
  '今天是 2026 年 11 月 3 日。帮我新建一个生活项目“家人的周末聚会”：室内活动，需要准备签到与到场名单。',
  '找一找我以前工作或生活中可以复用的经验，并把适用的经验关联到这个新项目。项目身份独立保留。',
  '另外记录我今天确认的一条安排：“这次家庭聚会有儿童参加，需要在签到后发放儿童餐券。”',
].join('\n');
try {
  runtime = await startDsh(root, '');
  report.dshVersion = runtime.dshVersion;
  const { ctx, defineTool, createUserMessage } = runtime;
  report.availableModels = (await ctx.llm.listModels(provider)).map(m => ({ id: m.id, name: m.name }));
  ctx.on('session/event', (session, event) => {
    const e = { sessionId: session.id, seq: event.seq, type: event.type };
    if (event.type === 'assistant/message') {
      e.text = event.data.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
      e.calls = event.data.message.content.filter(b => b.type === 'tool-call').map(({ id, name, arguments: args }) => ({ id, name, arguments: args }));
      e.usage = event.data.usage;
      e.provider = event.data.message.source.provider; e.model = event.data.message.source.model;
    } else if (event.type === 'tool/call') {
      e.callId = event.data.callId; e.name = event.data.name; e.arguments = event.data.arguments;
      console.log(JSON.stringify({ event: 'model-tool-call', sessionId: session.id, name: e.name }));
    } else if (event.type === 'turn/end') e.outcome = event.data;
    else if (event.type === 'request/header') e.config = event.data.config;
    // Omit reasoning, credentials, request headers, and replay signatures.
    events.push(e);
  });
  function options(scope, reviewOnly) {
    return { agentOptions: { provider, model, reasoningEffort, maxTokens: 8192 },
      setup(agentCtx) {
        agentCtx.systemPrompt.section({ name: 'memory-persona', order: 100, text: reviewOnly ? reviewerPersona : assistantPersona });
        registerModelTools(agentCtx, defineTool, store, scope, audit, { reviewOnly });
      } };
  }
  async function open(label, reviewOnly = false, resumed) {
    const scope = { owner: 'synthetic-live-user', sessionId: resumed ?? label + '-' + randomUUID(), source: null };
    const o = options(scope, reviewOnly);
    const handle = resumed ? await ctx.agents.resume({ resumeSessionId: resumed, ...o })
      : await ctx.agents.create({ sessionId: scope.sessionId, ...o });
    handles.add(handle); return { handle, scope };
  }
  async function close(session) { await session.handle.dispose(); handles.delete(session.handle); }
  async function turn(session, text, label) {
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } });
    session.scope.source = { id: message.id, text };
    const start = Date.now(), eventStart = events.length, auditStart = audit.length;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; session.handle.agent.cancel({ kind: 'user' }); }, 180_000);
    try { session.handle.agent.followup(message); await session.handle.agent.whenIdle(); }
    finally { clearTimeout(timer); }
    const current = events.slice(eventStart);
    const result = { label, sessionId: session.scope.sessionId, messageId: message.id, prompt: text,
      elapsedMs: Date.now() - start, tools: audit.slice(auditStart).map(a => ({ name: a.name, ok: a.ok, error: a.error })),
      reply: current.filter(e => e.type === 'assistant/message').map(e => e.text).filter(Boolean).join('\n'),
      end: current.filter(e => e.type === 'turn/end').at(-1)?.outcome };
    turns.push(result); console.log(JSON.stringify({ completed: label, elapsedMs: result.elapsedMs, tools: result.tools, end: result.end }));
    saveReport('live-model-progress.json', report);
    assert.equal(timedOut, false, 'Model turn timed out');
    assert.ok(current.some(e => e.type === 'assistant/message'), 'No actual model response');
    assert.equal(result.end?.reason?.kind, 'completed', 'Idle is not equivalent to a successfully completed turn');
    return result;
  }
  const historical = await open('history');
  await turn(historical, historicalPrompt, 'natural-language-history');
  const initial = store.inspect();
  const oldProject = initial.nodes.find(n => n.kind === 'project');
  const originalMemories = initial.nodes.filter(n => n.kind === 'memory');
  assert.equal(initial.nodes.filter(n => n.kind === 'project').length, 1);
  assert.equal(originalMemories.length, 3, 'Three separately extracted source statements');
  assert.ok(originalMemories.every(n => n.data.coverage === 'model-extracted' && n.data.observations.every(o => historicalPrompt.includes(o.quote) && o.at.startsWith('2025-11-'))));
  assert.equal(store.planConsolidation().groups.length, 0, 'Unreviewed model facts cannot auto-merge');
  stages.push({ step: 'history', projects: 1, memories: 3, unreviewedMergeGroups: 0 });
  await close(historical);

  let current = await open('current');
  await turn(current, newPrompt, 'fresh-session-new-project-and-recall');
  const before = store.inspect();
  const newProject = before.nodes.find(n => n.kind === 'project' && n.id !== oldProject.id);
  assert.ok(newProject); assert.equal(before.nodes.filter(n => n.kind === 'project').length, 2);
  assert.equal(before.nodes.filter(n => n.kind === 'memory').length, 4);
  const related = before.edges.filter(e => e.data.from === newProject.id && e.data.kind === 'reuses_method');
  assert.ok(related.length >= 2 && related.every(e => originalMemories.some(m => m.id === e.data.to)));
  assert.ok(audit.some(a => a.sessionId === current.scope.sessionId && a.name === 'memory_find'));
  stages.push({ step: 'new-project-and-year-old-recall', separateSession: true, oldProjectId: oldProject.id,
    newProjectId: newProject.id, recalledIds: related.map(e => e.data.to), memoryCount: 4 });

  const maintenance = await open('maintenance', true);
  await turn(maintenance, '现在执行一次例行记忆整理：复核已有记录，只合并明确重复、完整且适用条件相同的经验，保留独立例外和每一次发生时间。完成后告诉我修改的内容与可撤回时间。', 'independent-maintenance');
  const after = store.inspect();
  const batch = after.changes.at(-1);
  assert.ok(batch, 'No semantic duplicates qualified for a maintenance batch');
  assert.equal(batch.summary.groups, 1);
  assert.equal(after.nodes.filter(n => n.kind === 'memory').length, 3);
  const merged = after.nodes.find(n => n.kind === 'memory' && n.data.observations.length === 2);
  assert.ok(merged);
  assert.ok(merged.data.observations.every(o => historicalPrompt.includes(o.quote)));
  assert.equal(batch.expiresAt - batch.createdAt, 72 * 3_600_000);
  stages.push({ step: 'reviewed-maintenance', changeId: batch.id, mergedId: merged.id,
    groups: 1, beforeMemories: 4, afterMemories: 3, sourceQuotesRetained: 2, expiresAt: batch.expiresAt });
  await close(maintenance);

  await turn(current, '请把刚才整理后的“提前备离线名单、断网继续签到”那条经验的正文改为：“' + humanBody + '” 备注改为：“' + humanNotes + '” 这是我明确做出的人工修改。', 'human-edit-through-conversation');
  const edited = store.get('nodes', merged.id);
  assert.equal(edited.data.body, humanBody); assert.equal(edited.data.notes, humanNotes);
  stages.push({ step: 'human-edit', body: edited.data.body, notes: edited.data.notes, revision: edited.revision });
  const currentId = current.scope.sessionId;
  await close(current);
  current = await open('current', false, currentId);
  await turn(current, '撤回刚才那次自动整理，但保留我在整理之后改写的正文和备注。请恢复合并前各条记录及项目关联，告诉我实际保留下来的人工修改。', 'resume-session-and-undo');
  const undone = store.inspect();
  assert.equal(undone.nodes.filter(n => n.kind === 'memory').length, 4);
  assert.deepEqual(undone.edges.map(e => ({ id: e.id, data: e.data })), before.edges.map(e => ({ id: e.id, data: e.data })));
  assert.equal(store.get('nodes', merged.id).data.body, humanBody);
  assert.equal(store.get('nodes', merged.id).data.notes, humanNotes);
  assert.equal(store.get('nodes', merged.id).data.observations.length, 1);
  assert.ok(store.change(batch.id).undoResult.preserved.some(p => p.field === 'body'));
  assert.equal(undone.foreignKeyErrors, 0); assert.equal(undone.integrity, 'ok');
  assert.equal(undone.outbox.length, 2);
  stages.push({ step: 'undo-after-native-session-resume', restoredMemories: 4, restoredEdges: undone.edges.length,
    preservedBody: true, preservedNotes: true, foreignKeyErrors: 0, outboxEvents: undone.outbox.map(o => o.type) });
  await close(current);
  function jsonlFiles(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? jsonlFiles(join(dir, e.name)) : e.name.endsWith('.jsonl') ? [join(dir, e.name)] : []); }
  const sessionFiles = jsonlFiles(join(root, 'sessions'));
  report.persistence = { nativeJsonlFiles: sessionFiles.length,
    nativeEventLines: sessionFiles.reduce((n, p) => n + readFileSync(p, 'utf8').trim().split('\n').length, 0), resumedSessionId: currentId };
  assert.ok(sessionFiles.length >= 3);
  report.finalState = undone;
  report.passed = true;
} catch (e) {
  report.failure = { name: e.name, code: e.code, message: e.message };
  report.finalState = store.inspect();
  process.exitCode = 1;
} finally {
  for (const handle of handles) await handle.dispose();
  await runtime?.dispose(); store.close(); rmSync(root, { recursive: true, force: true });
  report.usage = events.filter(e => e.usage).reduce((s, e) => {
    for (const k of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens']) s[k] = (s[k] ?? 0) + (e.usage[k] ?? 0);
    s.responses++; return s;
  }, { responses: 0 });
  saveReport('live-model.json', report);
  console.log(JSON.stringify({ passed: report.passed, failure: report.failure, usage: report.usage, report: 'artifacts/live-model.json' }));
}
