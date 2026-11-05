import {
  ModelSelection,
  OrchestrationV2ThreadProjection,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import {
  decideProviderSessionTransition,
  type ProviderSessionTransition,
} from "./ProviderSessionTransitionPolicy.ts";

export interface ProviderSwitchPlanV2 {
  readonly instanceChanged: boolean;
  readonly requiresFreshProviderThread: boolean;
  readonly releaseProviderSessionIds: ReadonlyArray<ProviderSessionId>;
  readonly transition: ProviderSessionTransition;
}

export class ProviderSwitchPlanError extends Schema.TaggedError<ProviderSwitchPlanError>()(
  "ProviderSwitchPlanError",
  {
    threadId: ThreadId,
    targetProviderInstanceId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProviderSwitchServiceV2Shape {
  readonly plan: (input: {
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "providerSessions" | "providerThreads"
    > & {
      readonly runs?: ReadonlyArray<
        Pick<
          OrchestrationV2ThreadProjection["runs"][number],
          "providerThreadId" | "modelSelection" | "status"
        >
      >;
    };
    readonly targetModelSelection: ModelSelection;
    readonly currentModelSelectionKnown?: boolean;
  }) => Effect.Effect<ProviderSwitchPlanV2, ProviderSwitchPlanError>;
}

export class ProviderSwitchServiceV2 extends Context.Service<
  ProviderSwitchServiceV2,
  ProviderSwitchServiceV2Shape
>()("t3/orchestration-v2/ProviderSwitchService/ProviderSwitchServiceV2") {}

const isLiveProviderSession = (
  session: OrchestrationV2ThreadProjection["providerSessions"][number],
) => session.status !== "stopped" && session.status !== "error";

export const layer: Layer.Layer<
  ProviderSwitchServiceV2,
  never,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2
> = Layer.effect(
  ProviderSwitchServiceV2,
  Effect.gen(function* () {
    const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
    return ProviderSwitchServiceV2.of({
      plan: Effect.fn("ProviderSwitchService.plan")(
        function* ({ projection, targetModelSelection, currentModelSelectionKnown }) {
          const activeProviderThread = projection.providerThreads.find(
            (thread) => thread.id === projection.thread.activeProviderThreadId,
          );
          const priorRun =
            activeProviderThread === undefined
              ? undefined
              : projection.runs?.findLast(
                  (run) =>
                    run.providerThreadId === activeProviderThread.id &&
                    run.status !== "queued" &&
                    run.status !== "preparing",
                );
          const current = priorRun?.modelSelection ?? {
            ...projection.thread.modelSelection,
            ...(activeProviderThread
              ? { instanceId: activeProviderThread.providerInstanceId }
              : {}),
          };
          const sourceSelectionKnown =
            priorRun !== undefined
              ? true
              : (currentModelSelectionKnown ?? projection.runs === undefined);
          const instanceChanged = current.instanceId !== targetModelSelection.instanceId;
          const getMetadata = (instanceId: typeof current.instanceId) =>
            adapters.getMetadata !== undefined
              ? adapters.getMetadata(instanceId)
              : adapters.get(instanceId).pipe(
                  Effect.flatMap((adapter) =>
                    adapter.getCapabilities().pipe(
                      Effect.map((capabilities) => ({
                        driver: adapter.driver,
                        continuationKey: `${adapter.driver}:instance:${instanceId}`,
                        enabled: true,
                        capabilities,
                      })),
                    ),
                  ),
                );
          const currentInstance = yield* Effect.option(getMetadata(current.instanceId));
          const targetInstance = yield* Effect.option(getMetadata(targetModelSelection.instanceId));
          const targetAdapter = yield* Effect.option(adapters.get(targetModelSelection.instanceId));
          const currentSessions = projection.providerSessions
            .filter((session) => session.providerInstanceId === current.instanceId)
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
            );
          const currentSession =
            currentSessions.find(
              (session) =>
                isLiveProviderSession(session) &&
                session.id === activeProviderThread?.providerSessionId,
            ) ?? currentSessions.find(isLiveProviderSession);
          const negotiatedCapabilities =
            currentSession?.capabilities ?? currentSessions[0]?.capabilities;
          const sourceAdapter = yield* Effect.option(adapters.get(current.instanceId));
          const currentAgent = current.options?.find((option) => option.id === "agent")?.value;
          const targetAgent = targetModelSelection.options?.find(
            (option) => option.id === "agent",
          )?.value;
          if (
            Option.isNone(sourceAdapter) &&
            typeof currentAgent === "string" &&
            currentAgent.includes("@") &&
            currentAgent === targetAgent
          )
            return yield* new ProviderSwitchPlanError({
              threadId: projection.thread.id,
              targetProviderInstanceId: targetModelSelection.instanceId,
              cause:
                "The pinned source role cannot be verified because its provider is unavailable. Explicitly select a replacement Agent for a fresh context.",
            });
          let sourceRequiresFreshContext = false;
          if (
            Option.isSome(sourceAdapter) &&
            sourceAdapter.value.validateContextTransfer &&
            (priorRun !== undefined ||
              activeProviderThread?.nativeThreadRef != null ||
              currentSessions.length > 0) &&
            Option.isSome(targetInstance)
          ) {
            const sourceSelection = sourceSelectionKnown
              ? current
              : negotiatedCapabilities?.sessions.supportsMultipleProviderThreadsPerSession === true
                ? { instanceId: current.instanceId, model: current.model }
                : null;
            sourceRequiresFreshContext = (yield* sourceAdapter.value.validateContextTransfer({
              providerSessionId:
                activeProviderThread?.providerSessionId ?? currentSession?.id ?? null,
              modelSelection: sourceSelection,
              targetModelSelection,
              targetDriver: targetInstance.value.driver,
            })).requiresFreshProviderThread;
          }
          if (
            Option.isSome(targetAdapter) &&
            targetAdapter.value.validateContextTransfer &&
            Option.isSome(targetInstance)
          )
            yield* targetAdapter.value.validateContextTransfer({
              providerSessionId: null,
              modelSelection: targetModelSelection,
              targetModelSelection,
              targetDriver: targetInstance.value.driver,
            });
          const requiresSessionIsolation =
            Option.isSome(targetInstance) &&
            targetInstance.value.capabilities.sessions.supportsMultipleProviderThreadsPerSession &&
            (negotiatedCapabilities?.sessions.supportsMultipleProviderThreadsPerSession === true ||
              currentModelSelectionKnown === false) &&
            Option.isSome(targetAdapter) &&
            !(yield* targetAdapter.value.getCapabilities(targetModelSelection)).sessions
              .supportsMultipleProviderThreadsPerSession;
          const currentProviderThread = projection.providerThreads.find(
            (thread) =>
              thread.id === projection.thread.activeProviderThreadId &&
              thread.providerInstanceId === current.instanceId &&
              thread.nativeThreadRef !== null,
          );
          const selectionTransition =
            !modelSelectionsEqual(current, targetModelSelection) &&
            Option.isSome(targetAdapter) &&
            Option.isSome(currentInstance) &&
            Option.isSome(targetInstance) &&
            currentInstance.value.driver === targetInstance.value.driver &&
            (currentSession !== undefined || currentProviderThread !== undefined)
              ? yield* targetAdapter.value.planSelectionTransition({
                  current,
                  target: targetModelSelection,
                  sessionCapabilities: negotiatedCapabilities ?? currentInstance.value.capabilities,
                })
              : undefined;
          const transition =
            Option.isNone(targetInstance) || Option.isNone(targetAdapter)
              ? ({
                  type: "reject",
                  reason: "The target provider instance is unavailable.",
                } as const)
              : (requiresSessionIsolation || sourceRequiresFreshContext) &&
                  targetInstance.value.enabled &&
                  selectionTransition?.type !== "reject"
                ? ({ type: "create_with_handoff" } as const)
                : decideProviderSessionTransition({
                    current:
                      Option.isNone(currentInstance) ||
                      (currentSession === undefined && currentProviderThread === undefined)
                        ? null
                        : {
                            driver: currentInstance.value.driver,
                            continuationIdentity: {
                              driverKind: currentInstance.value.driver,
                              continuationKey: currentInstance.value.continuationKey,
                            },
                            modelSelection: current,
                            runtimeMode: projection.thread.runtimeMode,
                            interactionMode: projection.thread.interactionMode,
                            workspace:
                              currentSession?.cwd ??
                              projection.thread.worktreePath ??
                              "<unresolved-workspace>",
                          },
                    target: {
                      driver: targetInstance.value.driver,
                      continuationIdentity: {
                        driverKind: targetInstance.value.driver,
                        continuationKey: targetInstance.value.continuationKey,
                      },
                      modelSelection: targetModelSelection,
                      runtimeMode: projection.thread.runtimeMode,
                      interactionMode: projection.thread.interactionMode,
                      workspace:
                        projection.thread.worktreePath ??
                        currentSession?.cwd ??
                        "<unresolved-workspace>",
                      available: targetInstance.value.enabled,
                    },
                    ...(selectionTransition === undefined ? {} : { selectionTransition }),
                  });
          if (transition.type === "reject") {
            return yield* new ProviderSwitchPlanError({
              threadId: projection.thread.id,
              targetProviderInstanceId: targetModelSelection.instanceId,
              cause: transition.reason,
            });
          }
          const releaseProviderSessionIds = projection.providerSessions
            .filter((session) => {
              if (!isLiveProviderSession(session)) return false;
              if (transition.type === "restart_and_resume") {
                // Release only the replaced session; peers can serve pooled or delegated bindings.
                return session.id === currentSession?.id;
              }
              if (transition.type === "create_with_handoff") {
                return (
                  session.providerInstanceId !== targetModelSelection.instanceId ||
                  (!instanceChanged && session.id === currentSession?.id)
                );
              }
              return false;
            })
            .map((session) => session.id);
          return {
            instanceChanged,
            requiresFreshProviderThread:
              requiresSessionIsolation ||
              sourceRequiresFreshContext ||
              selectionTransition?.type === "create_with_handoff",
            releaseProviderSessionIds,
            transition,
          };
        },
        (effect, { projection, targetModelSelection }) =>
          effect.pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSwitchPlanError({
                  threadId: projection.thread.id,
                  targetProviderInstanceId: targetModelSelection.instanceId,
                  cause,
                }),
            ),
          ),
      ),
    });
  }),
);
