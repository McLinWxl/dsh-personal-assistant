export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived';
export type LinkRole = 'contains' | 'applies_to';
export type ProjectContextValues = Record<string, string | number | boolean>;

export interface ProjectData {
  owner: string;
  key: string;
  title: string;
  statement: string;
  parentId: string | null;
  path: string;
  depth: number;
  status: ProjectStatus;
  mergedInto: string | null;
  domains: string[];
  topics: string[];
  context: ProjectContextValues;
  aliases: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectNode {
  id: string;
  kind: 'project';
  revision: number;
  data: ProjectData;
}

export interface ProjectRef {
  id: string;
  revision: number;
}

export interface ProjectLink {
  objectId: string;
  projectId: string;
  role: LinkRole;
  confidence: number;
  createdBy: string;
  createdAt: number;
}

export interface TreeChange {
  id: string;
  changeId: string;
  action: string;
  objectId: string;
  title: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string;
  confidence: number;
  at: number;
}

export function normalizeProjectName(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s/gu, '');
}

export function projectContextsConflict(a: ProjectContextValues, b: ProjectContextValues): boolean {
  return Object.keys(a).some(
    (key) =>
      Object.hasOwn(b, key) && normalizeProjectName(String(a[key])) !== normalizeProjectName(String(b[key])),
  );
}
