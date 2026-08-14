// @effect-diagnostics nodeBuiltinImport:off
import type { CodexSettings } from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { expandHomePath } from "../../pathExpansion.ts";
import { ProviderAdapterRequestError, type ProviderAdapterError } from "../Errors.ts";
import type {
  ProviderNativeThreadCatalog,
  ProviderNativeThreadDetail,
  ProviderNativeThreadMessage,
  ProviderNativeThreadSummary,
} from "../ProviderNativeThreadCatalog.ts";
import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";

const CODEX_CATALOG_FORCE_KILL_AFTER = "2 seconds" as const;
const CODEX_THREAD_PAGE_SIZE = 100;
const IMPORTABLE_CODEX_SOURCES = ["cli", "vscode", "exec", "appServer"] as const;

function epochSecondsToIso(value: number): string {
  return new Date(value * 1_000).toISOString();
}

function titleForThread(thread: { readonly name?: string | null; readonly preview: string }): string {
  const explicit = thread.name?.trim();
  if (explicit) return explicit;
  const preview = thread.preview.trim().replace(/\s+/g, " ");
  if (!preview) return "Codex conversation";
  return preview.length <= 80 ? preview : `${preview.slice(0, 77)}...`;
}

function toThreadSummary(
  thread: CodexSchema.V2ThreadListResponse["data"][number] | CodexSchema.V2ThreadReadResponse["thread"],
): ProviderNativeThreadSummary {
  return {
    providerThreadId: thread.id,
    title: titleForThread(thread),
    preview: thread.preview,
    cwd: thread.cwd,
    createdAt: epochSecondsToIso(thread.createdAt),
    updatedAt: epochSecondsToIso(thread.updatedAt),
    source: thread.source,
  };
}

function readUserMessageText(item: Record<string, unknown>): string | undefined {
  const content = item.content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null) continue;
    const value = entry as Record<string, unknown>;
    if (value.type === "text" && typeof value.text === "string") {
      parts.push(value.text);
    }
  }
  const text = parts.join("\n").trim();
  return text.length > 0 ? text : undefined;
}

function readAgentMessageText(item: Record<string, unknown>): string | undefined {
  for (const key of ["text", "message", "content"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function messagesFromThread(
  thread: CodexSchema.V2ThreadReadResponse["thread"],
): ReadonlyArray<ProviderNativeThreadMessage> {
  const messages: ProviderNativeThreadMessage[] = [];
  let messageIndex = 0;
  for (const turn of thread.turns) {
    for (const rawItem of turn.items) {
      const item = rawItem as unknown as Record<string, unknown>;
      const itemId = typeof item.id === "string" ? item.id : `${turn.id}:${messageIndex}`;
      let role: ProviderNativeThreadMessage["role"] | undefined;
      let text: string | undefined;
      if (item.type === "userMessage") {
        role = "user";
        text = readUserMessageText(item);
      } else if (item.type === "agentMessage") {
        role = "assistant";
        text = readAgentMessageText(item);
      }
      if (!role || !text) continue;
      // Codex thread snapshots do not expose per-item timestamps. Preserve a
      // deterministic chronological order by spacing imported messages from
      // the thread creation time; subsequent sync passes therefore produce
      // exactly the same timestamps and ids.
      const createdAt = new Date(thread.createdAt * 1_000 + messageIndex).toISOString();
      messages.push({
        providerMessageId: itemId,
        providerTurnId: turn.id,
        role,
        text,
        createdAt,
      });
      messageIndex += 1;
    }
  }
  return messages;
}

function mapCatalogError(method: string, error: unknown): ProviderAdapterError {
  return new ProviderAdapterRequestError({
    provider: "codex",
    method,
    detail: error instanceof Error ? error.message : String(error),
    cause: error,
  });
}

export function makeCodexNativeThreadCatalog(input: {
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}): ProviderNativeThreadCatalog {
  const withClient = <A>(
    method: string,
    use: (client: CodexClient.CodexAppServerClient["Service"]) => Effect.Effect<A, unknown, never>,
  ): Effect.Effect<A, ProviderAdapterError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const resolvedHomePath = input.settings.homePath
          ? expandHomePath(input.settings.homePath)
          : undefined;
        const environment = {
          ...input.environment,
          ...(resolvedHomePath ? { CODEX_HOME: resolvedHomePath } : {}),
        };
        const launchArgs = resolveCodexLaunchArgs(input.settings.launchArgs, environment);
        const spawnCommand = yield* resolveSpawnCommand(
          input.settings.binaryPath,
          codexAppServerArgs(launchArgs),
          { env: environment, extendEnv: true },
        );
        const child = yield* input.spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: process.cwd(),
            env: environment,
            extendEnv: true,
            forceKillAfter: CODEX_CATALOG_FORCE_KILL_AFTER,
            shell: spawnCommand.shell,
          }),
        );
        const clientContext = yield* Layer.build(CodexClient.layerChildProcess(child));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );
        yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);
        return yield* use(client);
      }),
    ).pipe(Effect.mapError((error) => mapCatalogError(method, error)));

  const listThreads = () =>
    withClient(
      "thread/list",
      (client) =>
        Effect.gen(function* () {
          const threads: ProviderNativeThreadSummary[] = [];
          let cursor: string | null | undefined = undefined;
          do {
            const response = yield* client.request("thread/list", {
              limit: CODEX_THREAD_PAGE_SIZE,
              ...(cursor ? { cursor } : {}),
              sourceKinds: IMPORTABLE_CODEX_SOURCES,
              sortKey: "updated_at",
              sortDirection: "desc",
            });
            threads.push(...response.data.map(toThreadSummary));
            cursor = response.nextCursor;
          } while (cursor);
          return threads;
        }),
    );

  const readThread = (providerThreadId: string) =>
    withClient(
      "thread/read",
      (client) =>
        Effect.gen(function* () {
          const response = yield* client.request("thread/read", {
            threadId: providerThreadId,
            includeTurns: true,
          });
          return {
            ...toThreadSummary(response.thread),
            messages: messagesFromThread(response.thread),
          } satisfies ProviderNativeThreadDetail;
        }),
    );

  return { listThreads, readThread };
}
