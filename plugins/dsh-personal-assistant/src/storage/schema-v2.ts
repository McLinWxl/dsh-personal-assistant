import type { DatabaseSync } from 'node:sqlite';

export function createProjectSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
      key TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      title_norm TEXT NOT NULL,
      statement TEXT NOT NULL DEFAULT '',
      parent_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
      path TEXT NOT NULL,
      depth INTEGER NOT NULL CHECK(depth BETWEEN 1 AND 4),
      status TEXT NOT NULL CHECK(status IN ('active','paused','completed','archived')),
      merged_into TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
      domains TEXT NOT NULL DEFAULT '[]',
      topics TEXT NOT NULL DEFAULT '[]',
      context TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      CHECK(parent_id IS NULL OR parent_id != id),
      CHECK(merged_into IS NULL OR merged_into != id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS project_sibling_title
      ON projects(parent_id,title_norm) WHERE parent_id IS NOT NULL AND merged_into IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS project_root_title
      ON projects(title_norm) WHERE parent_id IS NULL AND merged_into IS NULL;
    CREATE INDEX IF NOT EXISTS project_parent ON projects(parent_id);
    CREATE INDEX IF NOT EXISTS project_path ON projects(path);
    CREATE TABLE IF NOT EXISTS project_aliases(
      project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
      alias TEXT NOT NULL, normalized TEXT NOT NULL,
      PRIMARY KEY(project_id,normalized), UNIQUE(normalized)
    );
    CREATE INDEX IF NOT EXISTS project_alias_name ON project_aliases(normalized);
    CREATE VIRTUAL TABLE IF NOT EXISTS project_search USING fts5(id UNINDEXED, terms);
    CREATE TABLE IF NOT EXISTS links(
      object_id TEXT NOT NULL REFERENCES nodes(id) DEFERRABLE INITIALLY DEFERRED,
      project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
      role TEXT NOT NULL CHECK(role IN ('contains','applies_to')),
      confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1),
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(object_id,project_id,role)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS links_one_contains ON links(object_id) WHERE role='contains';
    CREATE INDEX IF NOT EXISTS links_project ON links(project_id,role,object_id);
    CREATE TABLE IF NOT EXISTS session_projects(
      session_id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
      revision INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS source_projects(
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) DEFERRABLE INITIALLY DEFERRED,
      PRIMARY KEY(source_id,project_id)
    );
    CREATE TABLE IF NOT EXISTS project_resolutions(
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', result TEXT,
      attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, catalog TEXT
    );
    CREATE INDEX IF NOT EXISTS project_resolution_status ON project_resolutions(status,next_at);
    CREATE TABLE IF NOT EXISTS project_changes(
      id TEXT PRIMARY KEY, change_id TEXT NOT NULL REFERENCES changes(id) ON DELETE CASCADE,
      action TEXT NOT NULL, object_id TEXT NOT NULL, title TEXT NOT NULL,
      before_json TEXT, after_json TEXT, reason TEXT NOT NULL,
      confidence REAL NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_change_time ON project_changes(created_at);
    CREATE TABLE IF NOT EXISTS project_decisions(
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, phase TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('unresolved','failed','applied')),
      subject_id TEXT, title TEXT NOT NULL, reason TEXT NOT NULL,
      plan TEXT NOT NULL, change_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capability_gaps(
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
      target TEXT NOT NULL, code TEXT, observed_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
      occurrences INTEGER NOT NULL DEFAULT 1, context TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open', resolved_by TEXT, revision INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS capability_occurrences(
      event_id TEXT PRIMARY KEY, gap_id TEXT NOT NULL REFERENCES capability_gaps(id), observed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS capability_proposals(
      id TEXT PRIMARY KEY, fingerprint TEXT UNIQUE NOT NULL, kind TEXT NOT NULL,
      title TEXT NOT NULL, plan TEXT NOT NULL, gap_ids TEXT NOT NULL,
      tool_id TEXT REFERENCES nodes(id), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS command_usage(
      id TEXT PRIMARY KEY, target TEXT NOT NULL, actor TEXT NOT NULL, at INTEGER NOT NULL,
      outcome TEXT NOT NULL, error_code TEXT, parameter_shape TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS command_usage_time ON command_usage(at,target);
  `);
}
