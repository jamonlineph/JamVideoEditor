import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { EditError } from "@openedits/core";
import type { Settings } from "../workspace.js";

export type AiContent = Anthropic.Beta.BetaContentBlockParam;

export interface StructuredRequest<S extends z.ZodType> {
  schema: S;
  system: string;
  content: AiContent[];
  /** Thinking depth: low for description/lookup, medium for editorial judgment. */
  effort: "low" | "medium" | "high";
  maxTokens?: number;
}

export interface StructuredResult<T> {
  value: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/** What the engine needs from a model. Injectable so tests never call the real API. */
export interface AiClient {
  /** Why it cannot be used, or null when it is enabled. */
  unavailableReason(): string | null;
  structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>>;
}

/**
 * Claude via the official SDK. Only used when the creator opted in: an API key in the configured
 * environment variable, or `claude.enabled: true` in settings (for `ant auth login` profiles).
 * Requests use structured outputs and server-side refusal fallback (`fallbacks: "default"`).
 */
export class ClaudeClient implements AiClient {
  private client: Anthropic | null = null;

  constructor(private readonly settings: () => Settings) {}

  unavailableReason(): string | null {
    const s = this.settings().claude;
    if (s.enabled === false) return "Claude is turned off in settings (claude.enabled)";
    if (s.enabled === true || process.env[s.apiKeyEnv]) return null;
    return `Claude features are off: set ${s.apiKeyEnv} (or claude.enabled: true after \`ant auth login\`) to use them`;
  }

  async structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<StructuredResult<z.infer<S>>> {
    const reason = this.unavailableReason();
    if (reason) throw new EditError("NOT_IMPLEMENTED", reason);
    const s = this.settings().claude;
    this.client ??= new Anthropic(process.env[s.apiKeyEnv] ? { apiKey: process.env[s.apiKeyEnv] } : {});
    let message;
    try {
      message = await this.client.beta.messages.parse({
        model: s.model,
        max_tokens: req.maxTokens ?? 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema) },
        system: req.system,
        messages: [{ role: "user", content: req.content }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError) throw new EditError("NOT_IMPLEMENTED", `Claude rejected the credentials (${s.apiKeyEnv} or the active \`ant\` profile)`);
      if (e instanceof Anthropic.RateLimitError) throw new EditError("INTERNAL", "Claude is rate limited right now; try again shortly");
      if (e instanceof Anthropic.APIError) throw new EditError("INTERNAL", `Claude API error ${e.status ?? ""}: ${e.message}`);
      throw new EditError("INTERNAL", `Could not reach Claude: ${(e as Error).message}`);
    }
    if (message.stop_reason === "refusal") {
      throw new EditError("INVALID_ARGUMENT", `Claude declined this request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}`);
    }
    if (message.stop_reason === "max_tokens") throw new EditError("INTERNAL", "Claude's answer was cut off (max_tokens)");
    if (message.parsed_output == null) throw new EditError("INTERNAL", "Claude returned an answer that did not match the expected format");
    return { value: message.parsed_output as z.infer<S>, model: message.model, inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens };
  }
}

export function imageBlock(data: Buffer, mediaType: "image/jpeg" | "image/png" = "image/jpeg"): AiContent {
  return { type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } };
}
