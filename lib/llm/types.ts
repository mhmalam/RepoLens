export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

export interface StreamResult {
  /** Async iterable of text deltas. */
  stream: AsyncIterable<string>;
  /** Resolves after the stream ends. */
  usage: Promise<Usage>;
}

export interface Provider {
  name: string;
  model: string;
  stream(messages: ChatMessage[], opts?: { maxTokens?: number; apiKey?: string }): Promise<StreamResult>;
  complete(messages: ChatMessage[], opts?: { maxTokens?: number; apiKey?: string }): Promise<{ text: string; usage: Usage }>;
}

export type Tier = "fast" | "smart";
