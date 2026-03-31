/** Minimal OpenAI chat completion params (streaming). */
export interface ChatCompletionCreateParams {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
}
