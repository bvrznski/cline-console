export class ClineConsoleError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ClineConsoleError";
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
