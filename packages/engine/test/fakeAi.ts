import type { z } from "zod";
import type { AiClient, StructuredRequest, StructuredResult } from "../src/index.js";

/** Stand-in model client: answers from a queue (or a function) and records what it was asked. */
export class FakeAi implements AiClient {
  calls: StructuredRequest<z.ZodType>[] = [];
  constructor(private answer: (req: StructuredRequest<z.ZodType>) => unknown, private reason: string | null = null) {}
  unavailableReason() {
    return this.reason;
  }
  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    this.calls.push(req as unknown as StructuredRequest<z.ZodType>);
    const value = req.schema.parse(this.answer(req as unknown as StructuredRequest<z.ZodType>));
    return { value, model: "fake-model", inputTokens: 100, outputTokens: 50 };
  }
}
