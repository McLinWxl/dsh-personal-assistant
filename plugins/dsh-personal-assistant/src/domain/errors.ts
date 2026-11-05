export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly details: unknown = null,
  ) {
    super(code);
    this.name = 'DomainError';
  }
}

export function reject(code: string, details: unknown = null): never {
  throw new DomainError(code, details);
}
