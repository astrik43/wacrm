// ============================================================
// One error shape for every tool: { code, message, field? }.
// `code` is stable and machine-matchable; the model branches on it.
// ============================================================

export type McpErrorCode =
  | 'missing_scope'
  | 'invalid_input'
  | 'not_found'
  | 'confirm_required'
  | 'conflict'
  | 'rate_limited'
  | 'upstream_error'
  | 'outside_24h_window'
  | 'template_not_approved'
  | 'button_param_missing'
  | 'not_staff'
  | 'internal';

export class McpToolError extends Error {
  readonly code: McpErrorCode;
  readonly field?: string;

  constructor(code: McpErrorCode, message: string, field?: string) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    this.field = field;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) };
  }
}
