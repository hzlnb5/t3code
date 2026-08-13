import type * as Effect from "effect/Effect";
import type { ProviderAdapterError } from "./Errors.ts";

export interface ProviderNativeThreadSummary {
  readonly providerThreadId: string;
  readonly title: string;
  readonly preview: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly source: string;
}

export interface ProviderNativeThreadMessage {
  readonly providerMessageId: string;
  readonly providerTurnId: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface ProviderNativeThreadDetail extends ProviderNativeThreadSummary {
  readonly messages: ReadonlyArray<ProviderNativeThreadMessage>;
}

export interface ProviderNativeThreadCatalog {
  readonly listThreads: () => Effect.Effect<ReadonlyArray<ProviderNativeThreadSummary>, ProviderAdapterError>;
  readonly readThread: (providerThreadId: string) => Effect.Effect<ProviderNativeThreadDetail, ProviderAdapterError>;
}
