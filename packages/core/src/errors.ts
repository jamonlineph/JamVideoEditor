export type ErrorCode =
  | "NO_PROJECT_OPEN"
  | "PROJECT_NOT_FOUND"
  | "PROJECT_LOCKED"
  | "ELEMENT_NOT_FOUND"
  | "TRACK_NOT_FOUND"
  | "MEDIA_NOT_FOUND"
  | "TRANSITION_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "CATALOG_ITEM_NOT_FOUND"
  | "INVALID_ARGUMENT"
  | "INVALID_RANGE"
  | "INVALID_ELEMENT_TYPE"
  | "INCOMPATIBLE_TRACK"
  | "TRACK_LOCKED"
  | "VERSION_CONFLICT"
  | "NOTHING_TO_UNDO"
  | "NOTHING_TO_REDO"
  | "FILE_NOT_FOUND"
  | "UNSUPPORTED_MEDIA"
  | "PROBE_FAILED"
  | "NOT_IMPLEMENTED"
  | "INTERNAL";

/** Typed, user-facing error. MCP tools surface `code`, `message` and `details`. */
export class EditError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EditError";
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

export function invariant(condition: unknown, code: ErrorCode, message: string, details?: Record<string, unknown>): asserts condition {
  if (!condition) throw new EditError(code, message, details);
}
