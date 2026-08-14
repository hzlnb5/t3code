/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type { OrchestrationCommand, OrchestrationEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type {
  OrchestrationEventStoreError,
} from "../../persistence/Errors.ts";

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command. Dispatch is serialized through
   * the engine queue and deduplicated via command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Append a server-originated event through the same serialization queue as
   * normal commands. This is intentionally not part of the client command
   * schema: provider-native history import can persist/project/publish an
   * existing domain event without inventing a client-visible command or
   * triggering provider command reactors.
   */
  readonly appendImportedEvent: (
    event: Omit<OrchestrationEvent, "sequence">,
  ) => Effect.Effect<
    OrchestrationEvent,
    OrchestrationDispatchError | OrchestrationEventStoreError,
    never
  >;

  /** Hot runtime stream (new events only), not a historical replay. */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /** Latest sequence reflected in the engine's authoritative command model. */
  readonly latestSequence: Effect.Effect<number, never, never>;
}

export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
