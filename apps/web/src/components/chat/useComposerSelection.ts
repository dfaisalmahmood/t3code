import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { UnifiedSettings } from "@t3tools/contracts";
import type { Dispatch } from "react";
import type { ComposerThreadTarget, DraftSessionState } from "../../composerDraftStore";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  ProviderInteractionMode,
  RuntimeMode,
} from "@t3tools/contracts";
import type { deriveThreadStructureRuntime } from "@t3tools/client-runtime/state/thread-execution";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type SetStateAction } from "react";
import { useNavigate } from "@tanstack/react-router";
import { toastManager } from "../ui/toast";
import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { resolveNewDraftStartFromOrigin } from "../../lib/chatThreadActions";
import {
  type DraftThreadEnvMode,
  deriveEffectiveComposerModelState,
  useComposerDraftModelState,
  useComposerDraftStore,
} from "../../composerDraftStore";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  carryProviderAgentSelection,
  getProviderOptionDescriptors,
  resolveProviderForCwd,
} from "@t3tools/shared/model";
import {
  getStartedThreadModelChangeBlockReason,
  deriveLockedProvider,
  makeModelDisabledReason,
} from "../ChatView.logic";
interface ComposerSelectionInput {
  readonly environmentId: EnvironmentId;
  readonly composerDraftTarget: ComposerThreadTarget;
  readonly draftThread: DraftSessionState | null;
  readonly activeThread: EnvironmentThreadShell | undefined;
  readonly activeRuntime: ReturnType<typeof deriveThreadStructureRuntime>;
  readonly activeProjectSettings: {
    readonly settings: { readonly newWorktreesStartFromOrigin: boolean };
  };
  readonly settings: UnifiedSettings;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly cwd: string | null;
  readonly lockedProvider: ReturnType<typeof deriveLockedProvider>;
  readonly supportsProviderSwitchingViaHandoff: boolean;
  readonly multipleModelSelections: ReadonlyArray<ModelSelection> | null;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly interactionModeEnabled: boolean;
  readonly isLocalDraftThread: boolean;
  readonly canOverrideServerThreadEnvMode: boolean;
  readonly setPendingServerThreadEnvModeEntry: Dispatch<
    SetStateAction<{ readonly threadId: ThreadId; readonly mode: DraftThreadEnvMode } | null>
  >;
  readonly setPendingServerThreadStartFromOriginByThreadId: Dispatch<
    SetStateAction<Record<string, boolean>>
  >;
  readonly scheduleComposerFocus: () => void;
}

/**
 * The composer's choices for the next turn: provider and model, runtime and interaction mode,
 * and where a new thread runs (local or a new worktree, from the remote's tip or not).
 */
export function useComposerSelection(input: ComposerSelectionInput) {
  const {
    environmentId,
    composerDraftTarget,
    draftThread,
    activeThread,
    activeRuntime,
    activeProjectSettings,
    settings,
    providerStatuses,
    cwd,
    lockedProvider,
    supportsProviderSwitchingViaHandoff,
    multipleModelSelections,
    runtimeMode,
    interactionMode,
    interactionModeEnabled,
    isLocalDraftThread,
    canOverrideServerThreadEnvMode,
    setPendingServerThreadEnvModeEntry,
    setPendingServerThreadStartFromOriginByThreadId,
    scheduleComposerFocus,
  } = input;
  const navigate = useNavigate();
  const draftModelState = useComposerDraftModelState(composerDraftTarget);
  const setStickyComposerModelSelection = useComposerDraftStore(
    (store) => store.setStickyModelSelection,
  );
  const setComposerDraftModelSelection = useComposerDraftStore((store) => store.setModelSelection);
  const setComposerDraftRuntimeMode = useComposerDraftStore((store) => store.setRuntimeMode);
  const setComposerDraftInteractionMode = useComposerDraftStore(
    (store) => store.setInteractionMode,
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const handleRuntimeModeChange = (mode: RuntimeMode) => {
    if (mode === runtimeMode) return;
    setComposerDraftRuntimeMode(composerDraftTarget, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, { runtimeMode: mode });
    }
    scheduleComposerFocus();
  };
  const handleRuntimeModeChangeStable = useStableCallback(handleRuntimeModeChange);

  const handleInteractionModeChange = (mode: ProviderInteractionMode) => {
    if (mode === "plan" && !interactionModeEnabled) return;
    if (mode === interactionMode) return;
    setComposerDraftInteractionMode(composerDraftTarget, mode);
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, { interactionMode: mode });
    }
    scheduleComposerFocus();
  };
  const handleInteractionModeChangeStable = useStableCallback(handleInteractionModeChange);
  const toggleInteractionMode = () => {
    if (!interactionModeEnabled) return;
    handleInteractionModeChange(interactionMode === "plan" ? "default" : "plan");
  };
  const toggleInteractionModeStable = useStableCallback(toggleInteractionMode);
  const openProviderSetup = (instanceId: ProviderInstanceId) => {
    void navigate({
      to: "/settings/providers",
      search: { environmentId, instanceId },
    });
  };
  const openProviderSetupStable = useStableCallback(openProviderSetup);

  // Keyed on the fields it reads: the thread and runtime objects change with
  // every streamed event, and a new function re-renders the whole model picker.
  const hasStartedSession = activeRuntime !== null;
  const runtimeProviderInstanceId = activeRuntime?.providerInstanceId ?? null;
  const currentModelSelection = activeThread?.modelSelection ?? null;
  const getModelDisabledReason = makeModelDisabledReason(
    currentModelSelection
      ? {
          hasStartedSession,
          supportsProviderSwitchingViaHandoff,
          currentModelSelection,
          currentProviderInstanceId: runtimeProviderInstanceId,
        }
      : null,
  );

  const onProviderModelSelect = (
    instanceId: ProviderInstanceId,
    model: string,
    options?: { focusComposer?: boolean },
  ) => {
    if (!activeThread) return;
    const scopedProviders = providerStatuses.map((provider) =>
      resolveProviderForCwd(provider, cwd),
    );
    const entry = scopedProviders.find((snapshot) => snapshot.instanceId === instanceId);
    if (!entry) return;
    const resolvedDriverKind = entry.driver;
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      resolvedDriverKind !== null &&
      resolvedDriverKind !== lockedProvider
    ) {
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    if (
      !supportsProviderSwitchingViaHandoff &&
      lockedProvider !== null &&
      activeRuntime?.providerInstanceId
    ) {
      const currentEntry = providerStatuses.find(
        (snapshot) => snapshot.instanceId === activeRuntime.providerInstanceId,
      );
      if (
        currentEntry?.continuation?.groupKey &&
        entry?.continuation?.groupKey &&
        currentEntry.continuation.groupKey !== entry.continuation.groupKey
      ) {
        if (options?.focusComposer !== false) scheduleComposerFocus();
        return;
      }
    }
    const resolvedModel = resolveAppModelSelectionForInstance(
      instanceId,
      settings,
      scopedProviders,
      model,
    );
    if (!resolvedModel) {
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    const rememberedOptions =
      useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.[resolvedModel];
    const currentOptions = deriveEffectiveComposerModelState({
      draft: draftModelState,
      providers: scopedProviders,
      selectedProvider: entry.driver,
      selectedInstanceId: instanceId,
      threadModelSelection: activeThread.modelSelection,
      projectModelSelection: null,
      settings,
    }).modelOptions?.[instanceId];
    const carriedOptions = carryProviderAgentSelection({
      targetSelections: rememberedOptions,
      currentSelections: currentOptions,
    });
    const nextOptions = buildExplicitProviderOptionSelectionsFromDescriptors(
      getProviderOptionDescriptors({
        caps:
          entry?.models.find((candidate) => candidate.slug === resolvedModel)?.capabilities ?? {},
        selections: carriedOptions,
      }),
      carriedOptions,
    );
    const nextModelSelection: ModelSelection = nextOptions
      ? { instanceId, model: resolvedModel, options: nextOptions }
      : { instanceId, model: resolvedModel };
    const modelChangeBlockReason = getStartedThreadModelChangeBlockReason({
      hasStartedSession: activeRuntime !== null,
      supportsProviderSwitchingViaHandoff,
      currentModelSelection: activeThread.modelSelection,
      currentProviderInstanceId: activeRuntime?.providerInstanceId ?? null,
      nextModelSelection,
    });
    if (modelChangeBlockReason) {
      toastManager.add({
        type: "warning",
        title: modelChangeBlockReason.title,
        description: modelChangeBlockReason.description,
      });
      if (options?.focusComposer !== false) scheduleComposerFocus();
      return;
    }
    setComposerDraftModelSelection(
      scopeThreadRef(activeThread.environmentId, activeThread.id),
      nextModelSelection,
      { explicit: true, replaceOptions: true },
    );
    setStickyComposerModelSelection(nextModelSelection, { replaceOptions: true });
    if (options?.focusComposer !== false) scheduleComposerFocus();
  };
  const onProviderModelSelectStable = useStableCallback(onProviderModelSelect);
  const onEnvModeChange = (mode: DraftThreadEnvMode) => {
    if (multipleModelSelections !== null) return;
    if (canOverrideServerThreadEnvMode) {
      if (activeThread) setPendingServerThreadEnvModeEntry({ threadId: activeThread.id, mode });
      scheduleComposerFocus();
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        envMode: mode,
        startFromOrigin: resolveNewDraftStartFromOrigin({
          envMode: mode,
          newWorktreesStartFromOrigin: activeProjectSettings.settings.newWorktreesStartFromOrigin,
        }),
        ...(mode === "worktree" && draftThread?.worktreePath ? { worktreePath: null } : {}),
      });
    }
    scheduleComposerFocus();
  };
  const onEnvModeChangeStable = useStableCallback(onEnvModeChange);

  // Reads only the id: the shell changes on every streamed event, and a new handler
  // re-renders the branch toolbar and thread details panel with it.
  const activeThreadId = activeThread?.id;
  const onStartFromOriginChange = (nextStartFromOrigin: boolean) => {
    if (canOverrideServerThreadEnvMode && activeThreadId !== undefined) {
      setPendingServerThreadStartFromOriginByThreadId((current) =>
        current[activeThreadId] === nextStartFromOrigin
          ? current
          : { ...current, [activeThreadId]: nextStartFromOrigin },
      );
      return;
    }
    if (isLocalDraftThread) {
      setDraftThreadContext(composerDraftTarget, {
        startFromOrigin: nextStartFromOrigin,
      });
    }
  };
  return {
    getModelDisabledReason,
    handleInteractionModeChange,
    handleInteractionModeChangeStable,
    handleRuntimeModeChangeStable,
    onEnvModeChangeStable,
    onProviderModelSelectStable,
    onStartFromOriginChange,
    openProviderSetupStable,
    toggleInteractionModeStable,
  };
}
