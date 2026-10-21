import type { ZodError } from 'zod';

/** A config that fails to parse stops the review and is reported as such. */
export class ConfigValidationError extends Error {
  readonly issues: { path: string; message: string }[];

  constructor(message: string, issues: { path: string; message: string }[]) {
    super(message);
    this.name = 'ConfigValidationError';
    this.issues = issues;
  }

  static fromZodError(error: ZodError): ConfigValidationError {
    const issues = error.issues.map((i) => ({
      path: i.path.join('.') || '(root)',
      message: i.message,
    }));
    const summary = issues.map((i) => `  - ${i.path}: ${i.message}`).join('\n');
    return new ConfigValidationError(`配置校验失败:\n${summary}`, issues);
  }
}
