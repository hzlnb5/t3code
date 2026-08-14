// @effect-diagnostics nodeBuiltinImport:off
import { createHash } from "node:crypto";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationEvent,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import {
  canonicalizeProviderPath,
  providerPathsEqual,
  providerProjectName,
} from "../../provider/CodexSyncPath.ts";
import type { ProviderInstance } from "../../provider/ProviderDriver.ts";
import type {
  ProviderNativeThreadDetail,
  ProviderNativeThreadMessage,
} from "../../provider/ProviderNativeThreadCatalog.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBindingWithMetadata,
} from "../../provider/Services/ProviderSessionDirectory.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const SYNC_INTERVAL = "10 seconds" as const;

function stableId(prefix: string, input: string): string {
  return `${prefix}-${createHash("sha256").update(input).digest("hex").slice(0, 32)}`;
}

function nativeThreadKey(instanceId: ProviderInstanceId, providerThreadId: string): string {
  return `${instanceId}:${providerThreadId}`;
}

function bindingProviderThreadId(binding: ProviderRuntimeBindingWithMetadata): string | undefined {
  if (
    !binding.resumeCursor ||
    typeof binding.resumeCursor !== "object" ||
    Array.isArray(binding.resumeCursor)
  ) {
    return undefined;
  }
  const threadId = "threadId" in binding.resumeCursor ? binding.resumeCursor.threadId : undefined;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : undefined;
}

function commandId(kind: string, input: string): CommandId {
  return CommandId.make(stableId(`native-sync-${kind}`, input));
}

function projectIdForPath(pathKey: string): ProjectId {
  return ProjectId.make(stableId("native-sync-project", pathKey));
}

function threadIdForNativeThread(instanceId: ProviderInstanceId, providerThreadId: string): ThreadId {
  return ThreadId.make(stableId("native-sync-thread", `${instanceId}:${providerThreadId}`));
}

function messageIdForNativeMessage(
  instanceId: ProviderInstanceId,
  providerThreadId: string,
  providerMessageId: string,
): MessageId {
  return MessageId.make(
    stableId("native-sync-message", `${instanceId}:${providerThreadId}:${providerMessageId}`),
  );
}

function eventIdForNativeMessage(
  instanceId: ProviderInstanceId,
  providerThreadId: string,
  providerMessageId: string,
): EventId {
  return EventId.make(
    stableId("native-sync-event", `${instanceId}:${providerThreadId}:${providerMessageId}`),
  );
}

function chooseModelSelection(
  instanceId: ProviderInstanceId,
  models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean }>,
): ModelSelection | undefined {
  const model = models.find((candidate) => candidate.isDefault)?.slug ?? models[0]?.slug;
  return model ? { instanceId, model } : undefined;
}

function importedMessageEvent(input: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly providerThreadId: string;
  readonly message: ProviderNativeThreadMessage;
}): Omit<OrchestrationEvent, "sequence"> {
  const messageId = messageIdForNativeMessage(
    input.instanceId,
    input.providerThreadId,
    input.message.providerMessageId,
  );
  const importCommandId = commandId(
    "message",
    `${input.instanceId}:${input.providerThreadId}:${input.message.providerMessageId}`,
  );
  return {
    eventId: eventIdForNativeMessage(
      input.instanceId,
      input.providerThreadId,
      input.message.providerMessageId,
    ),
    aggregateKind: "thread",
    aggregateId: input.threadId,
    occurredAt: input.message.createdAt,
    commandId: importCommandId,
    causationEventId: null,
    correlationId: importCommandId,
    metadata: {
      providerTurnId: input.message.providerTurnId,
    },
    type: "thread.message-sent",
    payload: {
      threadId: input.threadId,
      messageId,
      role: input.message.role,
      text: input.message.text,
      turnId: TurnId.make(input.message.providerTurnId),
      streaming: false,
      createdAt: input.message.createdAt,
      updatedAt: input.message.createdAt,
    },
  };
}

function findBoundThread(
  bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
  instanceId: ProviderInstanceId,
  providerThreadId: string,
): ThreadId | undefined {
  for (const binding of bindings) {
    if (binding.providerInstanceId !== instanceId) continue;
    if (bindingProviderThreadId(binding) === providerThreadId) return binding.threadId;
  }
  return undefined;
}

export const makeProviderNativeThreadSync = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const directory = yield* ProviderSessionDirectory;
  const engine = yield* OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery;
  const syncedVersionByNativeThread = yield* Ref.make(new Map<string, string>());

  const syncDetail = Effect.fn("ProviderNativeThreadSync.syncDetail")(function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: ProviderDriverKind;
    readonly modelSelection: ModelSelection;
    readonly detail: ProviderNativeThreadDetail;
    readonly bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>;
  }) {
    const canonicalPath = canonicalizeProviderPath(input.detail.cwd);
    if (!canonicalPath || canonicalPath.isRoot) {
      return;
    }

    const shell = yield* projections.getShellSnapshot();
    const existingProject = shell.projects.find((candidate) =>
      providerPathsEqual(candidate.workspaceRoot, canonicalPath.path),
    );
    const projectId = existingProject?.id ?? projectIdForPath(canonicalPath.key);
    if (!existingProject) {
      yield* engine.dispatch({
        type: "project.create",
        commandId: commandId("project", canonicalPath.key),
        projectId,
        title: providerProjectName(canonicalPath),
        workspaceRoot: canonicalPath.path,
        defaultModelSelection: input.modelSelection,
        createdAt: input.detail.createdAt,
      });
    }

    const boundThreadId = findBoundThread(
      input.bindings,
      input.instanceId,
      input.detail.providerThreadId,
    );
    const threadId =
      boundThreadId ?? threadIdForNativeThread(input.instanceId, input.detail.providerThreadId);
    const threadShell = Option.getOrUndefined(yield* projections.getThreadShellById(threadId));
    if (!threadShell) {
      yield* engine.dispatch({
        type: "thread.create",
        commandId: commandId(
          "thread",
          `${input.instanceId}:${input.detail.providerThreadId}`,
        ),
        threadId,
        projectId,
        title: input.detail.title,
        modelSelection: input.modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt: input.detail.createdAt,
      });
    }

    const detailSnapshot = Option.getOrUndefined(yield* projections.getThreadDetailById(threadId));
    const existingMessageIds = new Set(detailSnapshot?.messages.map((message) => message.id) ?? []);
    for (const message of input.detail.messages) {
      const importedMessageId = messageIdForNativeMessage(
        input.instanceId,
        input.detail.providerThreadId,
        message.providerMessageId,
      );
      if (existingMessageIds.has(importedMessageId)) continue;
      yield* engine.appendImportedEvent(
        importedMessageEvent({
          instanceId: input.instanceId,
          threadId,
          providerThreadId: input.detail.providerThreadId,
          message,
        }),
      );
      existingMessageIds.add(importedMessageId);
    }

    // Existing T3-created threads already own a runtime binding. Never mutate
    // its status/runtime payload from the background importer: doing so could
    // turn an actively-running T3 session into "stopped" while Codex is still
    // producing events. Only native threads discovered for the first time get
    // a new binding that points at the provider's durable thread id.
    if (boundThreadId === undefined) {
      yield* directory.upsert({
        threadId,
        provider: input.driverKind,
        providerInstanceId: input.instanceId,
        status: "stopped",
        resumeCursor: { threadId: input.detail.providerThreadId },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        runtimePayload: {
          cwd: canonicalPath.path,
          model: input.modelSelection.model,
          activeTurnId: null,
          lastError: null,
          modelSelection: input.modelSelection,
        },
      });
    }
  });

  const syncInstance = Effect.fn("ProviderNativeThreadSync.syncInstance")(function* (
    instance: ProviderInstance,
  ) {
    const catalog = instance.nativeThreadCatalog;
    if (!instance.enabled || !catalog) return;
    const providerSnapshot = yield* instance.snapshot.getSnapshot;
    const modelSelection = chooseModelSelection(instance.instanceId, providerSnapshot.models);
    if (!modelSelection) {
      yield* Effect.logWarning("Skipping native thread sync because provider has no models", {
        providerInstanceId: instance.instanceId,
      });
      return;
    }
    const [summaries, bindings] = yield* Effect.all([
      catalog.listThreads(),
      directory.listBindings(),
    ]);
    const versions = yield* Ref.get(syncedVersionByNativeThread);
    for (const summary of summaries) {
      const key = nativeThreadKey(instance.instanceId, summary.providerThreadId);
      if (versions.get(key) === summary.updatedAt) continue;
      const detail = yield* catalog.readThread(summary.providerThreadId);
      yield* syncDetail({
        instanceId: instance.instanceId,
        driverKind: instance.driverKind,
        modelSelection,
        detail,
        bindings,
      });
      yield* Ref.update(syncedVersionByNativeThread, (current) => {
        const next = new Map(current);
        next.set(key, summary.updatedAt);
        return next;
      });
    }
  });

  const syncOnce = Effect.gen(function* () {
    const instances = yield* registry.listInstances;
    yield* Effect.forEach(
      instances,
      (instance) =>
        syncInstance(instance).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider native thread sync failed", {
              providerInstanceId: instance.instanceId,
              provider: instance.driverKind,
              cause,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  const start = Effect.gen(function* () {
    yield* Effect.forkScoped(
      Effect.forever(
        syncOnce.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider native thread sync cycle failed", { cause }),
          ),
          Effect.andThen(Effect.sleep(SYNC_INTERVAL)),
        ),
      ),
    );
  });

  return { start } as const;
});
