import type { Project } from "../schema.js";
import type { IdGenerator } from "../ids.js";

/** Mutable state shared by all ops inside one transaction (one undo step). */
export class EditContext {
  /** Elements changed by the op itself (used for overlap resolution and reporting). */
  readonly touched = new Set<string>();
  /** Free elements whose start was set explicitly by the op; ripple will not move them. */
  readonly positioned = new Set<string>();
  readonly created: string[] = [];
  readonly removed: string[] = [];
  readonly warnings: string[] = [];

  constructor(
    public readonly draft: Project,
    public readonly ids: IdGenerator,
    public readonly now: number,
  ) {}

  warn(message: string) {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  touch(...ids: string[]) {
    for (const id of ids) this.touched.add(id);
  }
}
