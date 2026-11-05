import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {projectPlan, projectSelection, projectPrompt, experiencePrompt, projectMaintenancePlan, projectMaintenancePrompt} from '../domain/projects.js';
import {schemas} from '../domain/contracts.js';
import type {AssistantService} from './service.js';

export class ProjectLifecycle {
  private readonly active = new Map<string, Promise<unknown>>();
  constructor(private readonly service: AssistantService) {}
  get running(): boolean { return this.active.size > 0; }

  async model<T extends z.ZodType>(schema: T, prompt: string, input: unknown, deadline: number, signal?: AbortSignal): Promise<z.output<T>> {
    return schema.parse(await this.service.projectModel(schema, prompt, input, deadline, signal));
  }

  resolve(sourceId: string, deadline = Date.now() + 180000, signal?: AbortSignal, trigger: 'conversation' | 'background' = 'conversation'): Promise<unknown> {
    if (this.service.acceptingProjects === false) throw new Error('ASSISTANT_RELOADING');
    const previous = this.active.get(sourceId);
    if (previous) return previous;
    const promise = this.run(sourceId, deadline, signal, trigger).finally(() => this.active.delete(sourceId));
    this.active.set(sourceId, promise);
    return promise;
  }

  private async run(sourceId: string, deadline: number, signal: AbortSignal | undefined, trigger: 'conversation' | 'background'): Promise<unknown> {
    let validationError: string | undefined, previousPlan: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted(); this.service.shutdownSignal.throwIfAborted();
      const context = await this.service.storage.call('projectInspect', {sourceId});
      if (context.result) return context.result;
      if (context.source.text.length > 100000) {
        return this.service.storage.call('projectApply', {sourceId, snapshot: context.snapshot,
          plan: {decisions: [{action: 'none', disposition: 'unresolved', quote: context.source.text.slice(0, 100), reason: '来源过长，需按独立事项处理', confidence: 0}]},
          selections: [], requestId: randomUUID()});
      }
      try {
        const plan = await this.model(projectPlan, projectPrompt, {now: new Date().toISOString(), trigger, ...context, previousPlan, validationError}, deadline, signal);
        previousPlan = plan;
        if (trigger === 'background' && plan.decisions.some(item => item.action === 'none' && item.disposition === 'defer')) throw new Error('PROJECT_DECISION_INVALID');
        const input = {sourceId, snapshot: context.snapshot, plan, selections: []};
        const preview = await this.service.storage.call('projectPreview', input);
        if (preview.result) return preview.result;
        const selection = preview.targets.some(item => item.memories.length || item.captured.length)
          ? await this.model(projectSelection, experiencePrompt, {targets: preview.targets}, deadline, signal) : {selections: []};
        signal?.throwIfAborted(); this.service.shutdownSignal.throwIfAborted();
        return await this.service.storage.call('projectApply', {...input, ...selection, requestId: randomUUID()});
      } catch (error) {
        validationError = (error as Error).message;
        if (signal?.aborted || this.service.shutdownSignal.aborted || Date.now() + 1000 >= deadline || attempt === 2) throw error;
      }
    }
    throw new Error('PROJECT_RESOLUTION_EXHAUSTED');
  }

  async drain(deadline: number, busy: string[], limit: number): Promise<number> {
    let processed = 0;
    for (const source of await this.service.storage.call('projectPending', {limit, busy})) {
      if (busy.includes(source.session_id)) continue;
      if (deadline - Date.now() < 15000) break;
      try { await this.resolve(source.id, deadline, undefined, 'background'); processed++; }
      catch (error) {
        if (this.service.shutdownSignal.aborted) throw error;
        await this.service.storage.call('projectRetry', {sourceId: source.id, error: (error as Error).message});
      }
    }
    return processed;
  }

  async maintain(phase: 'structure' | 'membership', deadline: number, limit: number): Promise<unknown> {
    const context = await this.service.storage.call('projectMaintenanceContext', {phase, limit});
    const names = phase === 'structure'
      ? ['projectMove','projectMerge','projectSplit','projectRename','projectArchive','projectRemove'] as const
      : ['projectAttach','projectDetach'] as const;
    const contracts = Object.fromEntries(names.map(name => [name, z.toJSONSchema(schemas[name]) ]));
    const plan = await this.model(projectMaintenancePlan, projectMaintenancePrompt + '\n本阶段命令契约：' + JSON.stringify(contracts), context, deadline);
    const result = await this.service.storage.call('projectMaintenanceApply', {phase, snapshot: context.snapshot, plan, requestId: randomUUID()});
    await this.service.storage.call('projectMaintenanceProgress', {phase, offset: context.offset + limit, total: context.totalObjects});
    return result;
  }

  async settled(): Promise<void> { await Promise.allSettled(this.active.values()); }
}
