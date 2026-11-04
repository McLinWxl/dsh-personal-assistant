import { MemoryStore } from './memory-store.mjs';

// Private spike adapter: invoked only by the isolated verification process.
// defineTool is supplied from the installed DSH package, never a mock implementation.
export function createHostPlugin(defineTool) {
  return {
    name: 'memory-lifecycle-spike', inject: ['tools'],
    apply(ctx, config) {
      const store = new MemoryStore(config.root, { clock: config.clock });
      ctx.effect(() => () => store.close());
      const string = { type: 'string', required: true };
      const definitions = [
        ['project_create', { payload: string, requestId: string }, a => store.createProject(JSON.parse(a.payload), a.requestId)],
        ['memory_find', { projectId: string }, a => store.findRelated(a.projectId)],
        ['memory_associate', { projectId: string, requestId: string }, a => store.associate(a.projectId, a.requestId)],
        ['memory_maintain', { requestId: string }, a => store.maintain(a.requestId)],
        ['memory_get', { id: string }, a => store.get('nodes', a.id)],
        ['memory_edit', { id: string, patch: string, revision: { type: 'integer', required: true }, requestId: string },
          a => store.editMemory(a.id, JSON.parse(a.patch), a.revision, a.requestId)],
        ['memory_undo', { changeId: string, requestId: string }, a => store.undo(a.changeId, a.requestId)],
        ['memory_inspect', {}, () => store.inspect()],
      ];
      for (const [suffix, parameters, execute] of definitions) ctx.tools.register(defineTool({
        name: `spike_${suffix}`, description: `隔离验证：${suffix}`, parameters,
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute(args) { return JSON.stringify(execute(args)); },
      }));
    },
  };
}

export function toolPort(tools) {
  const call = async (suffix, args) => JSON.parse(await tools.get(`spike_${suffix}`).execute(args, {}));
  return {
    createProject: (data, requestId) => call('project_create', { payload: JSON.stringify(data), requestId }),
    findRelated: projectId => call('memory_find', { projectId }),
    associate: (projectId, requestId) => call('memory_associate', { projectId, requestId }),
    maintain: requestId => call('memory_maintain', { requestId }),
    getMemory: id => call('memory_get', { id }),
    edit: (id, patch, revision, requestId) => call('memory_edit', { id, patch: JSON.stringify(patch), revision, requestId }),
    undo: (changeId, requestId) => call('memory_undo', { changeId, requestId }),
    inspect: () => call('memory_inspect', {}),
  };
}
