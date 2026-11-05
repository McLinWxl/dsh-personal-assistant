import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { schemas, type Actor } from '../domain/contracts.js';
import { commands, commandCatalog } from '../domain/commands.js';
import { reject } from '../domain/errors.js';
import { digest } from './memory-base.mjs';
import type { Store } from './store.js';

type GapInput = z.infer<typeof schemas.capabilityGapReport>;
type GapStatus = 'open' | 'planned' | 'resolved' | 'dismissed';

export function parameterShape(value: unknown, depth = 0): unknown {
  if (depth > 4) return 'nested';
  if (value === null) return 'null';
  if (Array.isArray(value))
    return {
      array: [
        ...new Set(value.slice(0, 20).map((item) => JSON.stringify(parameterShape(item, depth + 1)))),
      ].sort(),
    };
  if (typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, 80)
        .map(([key, item]) => [key, parameterShape(item, depth + 1)]),
    );
  return typeof value;
}

const prerequisiteCodes = new Set([
  'WORKFLOW_TOOL_UNAVAILABLE',
  'TOOL_EXECUTION_NOT_AVAILABLE',
  'CAPABILITY_NOT_IMPLEMENTED',
]);

export class Capabilities {
  constructor(private readonly store: Store) {}

  report(input: GapInput, eventId: string): { id: string; recorded: boolean } {
    const fingerprint = digest({ kind: input.kind, target: input.target, code: input.code ?? null });
    const previous = this.store.db
      .prepare('SELECT * FROM capability_gaps WHERE fingerprint=?')
      .get(fingerprint);
    const id = previous?.id ?? randomUUID(),
      now = this.store.now();
    if (this.store.db.prepare('SELECT 1 FROM capability_occurrences WHERE event_id=?').get(eventId))
      return { id, recorded: false };
    if (previous)
      this.store.db
        .prepare(
          `UPDATE capability_gaps SET last_seen_at=?,occurrences=occurrences+1,
      context=?,revision=revision+1,status=CASE WHEN status='resolved' THEN 'open' ELSE status END WHERE id=?`,
        )
        .run(now, input.context.slice(0, 2000), id);
    else
      this.store.db
        .prepare(
          `INSERT INTO capability_gaps(id,fingerprint,kind,target,code,observed_at,last_seen_at,context)
      VALUES(?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          fingerprint,
          input.kind,
          input.target,
          input.code ?? null,
          now,
          now,
          input.context.slice(0, 2000),
        );
    this.store.db.prepare('INSERT INTO capability_occurrences VALUES(?,?,?)').run(eventId, id, now);
    return { id, recorded: true };
  }

  observe(
    id: string,
    target: string,
    actor: Actor,
    payload: unknown,
    error?: { code?: string; message?: string },
  ): void {
    const code = error?.code ?? error?.message ?? null;
    this.store.db
      .prepare('INSERT OR IGNORE INTO command_usage VALUES(?,?,?,?,?,?,?)')
      .run(
        id,
        target,
        actor.kind,
        this.store.now(),
        error ? 'failed' : 'succeeded',
        code,
        JSON.stringify(parameterShape(payload)),
      );
    if (!['model', 'maintenance'].includes(actor.kind) || !code) return;
    if (['UNKNOWN_COMMAND', 'UNKNOWN_TOOL', 'TOOL_NOT_FOUND'].includes(code) || prerequisiteCodes.has(code)) {
      this.report(
        {
          kind: prerequisiteCodes.has(code) ? 'prerequisite' : 'unavailable',
          target,
          code,
          context: `命令 ${target} 返回 ${code}。`,
        },
        id,
      );
    }
  }

  list(status?: GapStatus, limit = 40, window?: { from: number; to: number }): Record<string, unknown>[] {
    const query = window
      ? this.store.db
          .prepare(
            'SELECT * FROM capability_gaps WHERE last_seen_at>=? AND last_seen_at<? ORDER BY last_seen_at,id',
          )
          .all(window.from, window.to)
      : this.store.db
          .prepare(
            `SELECT * FROM capability_gaps${status ? ' WHERE status=?' : ''}
        ORDER BY last_seen_at DESC,id LIMIT ?`,
          )
          .all(...(status ? [status, limit] : [limit]));
    return query.map((row: Record<string, unknown>) => ({
      ...row,
      proposals: this.store.db
        .prepare('SELECT id,kind,title,plan,tool_id AS toolId,gap_ids FROM capability_proposals')
        .all()
        .filter((proposal: { gap_ids: string }) =>
          (JSON.parse(proposal.gap_ids) as string[]).includes(String(row.id)),
        ),
    }));
  }

  update(input: z.infer<typeof schemas.capabilityGapUpdate>): { id: string; status: GapStatus } {
    const gap = this.store.db.prepare('SELECT * FROM capability_gaps WHERE id=?').get(input.id);
    if (!gap) reject('CAPABILITY_GAP_NOT_FOUND');
    if (gap.revision !== input.revision) reject('STALE_VERSION');
    if (input.toolId) {
      const tool = this.store.node(input.toolId, 'tool');
      if (input.status === 'resolved' && tool.data.status !== 'active') reject('CAPABILITY_TOOL_NOT_ACTIVE');
    }
    if (input.status === 'resolved' && gap.kind === 'unavailable' && gap.target.startsWith('assistant_')) {
      const command = gap.target.slice('assistant_'.length) as keyof typeof commands;
      if (
        !commands[command]?.agent &&
        !['projectResolve', 'toolPlan', 'sendFile', 'executeWorkflow'].includes(command)
      )
        reject('CAPABILITY_STILL_UNAVAILABLE');
    }
    this.store.db
      .prepare('UPDATE capability_gaps SET status=?,resolved_by=?,revision=revision+1 WHERE id=?')
      .run(
        input.status,
        JSON.stringify({ resolution: input.resolution, toolId: input.toolId ?? null, at: this.store.now() }),
        input.id,
      );
    return { id: input.id, status: input.status };
  }

  propose(input: z.infer<typeof schemas.capabilityProposal>): { id: string; unchanged?: boolean } {
    const gapIds = [...new Set(input.gapIds)].sort();
    for (const id of gapIds)
      if (!this.store.db.prepare('SELECT 1 FROM capability_gaps WHERE id=?').get(id))
        reject('CAPABILITY_GAP_NOT_FOUND', { id });
    if (input.toolId) this.store.node(input.toolId, 'tool');
    if (input.kind !== 'workflow' && input.toolId) reject('CAPABILITY_PROPOSAL_KIND_MISMATCH');
    const fingerprint = digest({ gapIds, kind: input.kind, toolId: input.toolId ?? null });
    const old = this.store.db
      .prepare('SELECT id FROM capability_proposals WHERE fingerprint=?')
      .get(fingerprint);
    if (old) return { id: old.id, unchanged: true };
    const id = randomUUID();
    this.store.db
      .prepare('INSERT INTO capability_proposals VALUES(?,?,?,?,?,?,?,?)')
      .run(
        id,
        fingerprint,
        input.kind,
        input.title,
        input.plan,
        JSON.stringify(gapIds),
        input.toolId ?? null,
        this.store.now(),
      );
    for (const gapId of gapIds)
      this.store.db
        .prepare(
          "UPDATE capability_gaps SET status='planned',revision=revision+1 WHERE id=? AND status='open'",
        )
        .run(gapId);
    return { id };
  }

  review(): { usage: unknown[]; gaps: unknown[]; catalog: ReturnType<typeof commandCatalog> } {
    return {
      usage: this.store.db
        .prepare(
          `SELECT target,parameter_shape AS parameterShape,COUNT(*) AS executions,
        SUM(CASE WHEN outcome='failed' THEN 1 ELSE 0 END) AS failures,error_code AS errorCode
        FROM command_usage WHERE at>? GROUP BY target,parameter_shape,error_code`,
        )
        .all(this.store.now() - 7 * 86400000),
      gaps: this.list().filter((gap) => ['open', 'planned'].includes(String(gap.status))),
      catalog: commandCatalog(),
    };
  }
}
