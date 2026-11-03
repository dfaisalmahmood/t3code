import { RegistryContext } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerConfig,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { createDraft } from "./scheduledTaskDraft";
import {
  scheduledTaskEditorSessionAtom,
  startScheduledTaskEditor,
} from "./scheduled-task-editor-state";

const mocks = vi.hoisted(() => ({
  configs: new Map<EnvironmentId, Pick<ServerConfig, "settings" | "providers">>(),
  projects: new Array<{ environmentId: EnvironmentId; id: ProjectId; workspaceRoot: string }>(),
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => mocks.projects,
  useServerConfigs: () => mocks.configs,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [],
    selectedProjectKey: null,
    projectGroups: [],
  }),
}));

import { useScheduledTaskEditor } from "./scheduled-task-editor";

afterEach(() => appAtomRegistry.set(scheduledTaskEditorSessionAtom, null));

it.each(["root-model", null])(
  "reconciles automatic models through checkout transitions from %s",
  async (rootModel) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const environmentId = EnvironmentId.make("environment");
    const projectId = ProjectId.make("project");
    const instanceId = ProviderInstanceId.make("codex");
    const model = (slug: string) => ({
      slug,
      name: slug,
      isCustom: false,
      isDefault: true,
      capabilities: null,
    });
    mocks.projects = [{ environmentId, id: projectId, workspaceRoot: "/root" }];
    mocks.configs.set(environmentId, {
      settings: DEFAULT_SERVER_SETTINGS,
      providers: [
        {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          displayName: "Codex",
          enabled: true,
          installed: true,
          version: null,
          checkedAt: "2026-01-01T00:00:00.000Z",
          slashCommands: [],
          skills: [],
          status: "ready",
          auth: { status: "authenticated" },
          models: [model("host-model")],
          workspaceSnapshots: [
            { cwd: "/root", models: rootModel ? [model(rootModel)] : [] },
            { cwd: "/checkout", models: [model("checkout-model")] },
            { cwd: "/other", models: [model("other-model")] },
            { cwd: "/empty", models: [] },
          ].map((snapshot) => ({
            ...snapshot,
            checkedAt: "2026-01-01T00:00:00.000Z",
            slashCommands: [],
            skills: [],
          })),
        },
      ],
    });
    startScheduledTaskEditor({
      environmentId,
      environmentLabel: "Environment",
      draft: createDraft(projectId, rootModel ? { instanceId, model: rootModel } : null),
    });
    const root = createRoot(document.createElement("div"));
    let read: () => ReturnType<typeof useScheduledTaskEditor> = () => {
      throw new Error("Editor not rendered");
    };
    function Probe() {
      const value = useScheduledTaskEditor();
      read = () => value;
      return null;
    }
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={appAtomRegistry}>
          <Probe />
        </RegistryContext.Provider>,
      ),
    );
    const changeWorkspace = async (
      workspace: "root" | "existing_worktree" | "worktree",
      checkoutPath: string,
    ) => {
      const editor = read().editor!;
      await act(async () =>
        read().setEditor({ ...editor, draft: { ...editor.draft, workspace, checkoutPath } }),
      );
    };
    try {
      expect(read().editor?.draft.modelSelection?.model ?? null).toBe(rootModel);
      await changeWorkspace("existing_worktree", " /checkout ");
      expect(read().editor?.draft.modelSelection).toEqual({ instanceId, model: "checkout-model" });
      await changeWorkspace("existing_worktree", "/other");
      expect(read().editor?.draft.modelSelection).toEqual({ instanceId, model: "other-model" });
      expect(read().readEditor()?.draft.modelSelection).toEqual({
        instanceId,
        model: "other-model",
      });
      await changeWorkspace("existing_worktree", "/empty");
      expect(read().editor?.draft.modelSelection).toBeNull();
      expect(read().readEditor()?.draft.modelSelection).toBeNull();
      await changeWorkspace("existing_worktree", "/checkout");
      expect(read().editor?.draft.modelSelection?.model).toBe("checkout-model");
      await changeWorkspace("root", "/checkout");
      expect(read().editor?.draft.modelSelection?.model ?? null).toBe(rootModel);
      await changeWorkspace("worktree", "/checkout");
      expect(read().editor?.draft.modelSelection?.model ?? null).toBe(rootModel);
      await changeWorkspace("existing_worktree", "/checkout");
      const options = [{ id: "agent", value: "reviewer" }];
      await act(async () =>
        read().setEditor(
          (current) =>
            current && {
              ...current,
              draft: {
                ...current.draft,
                modelSelection: current.draft.modelSelection && {
                  ...current.draft.modelSelection,
                  options,
                },
                modelSelectionIsExplicit: true,
              },
            },
        ),
      );
      await changeWorkspace("existing_worktree", "/empty");
      expect(read().editor?.draft.modelSelection).toEqual({
        instanceId,
        model: "checkout-model",
        options,
      });
      expect(read().editor?.draft.modelSelectionIsExplicit).toBe(true);
    } finally {
      act(() => root.unmount());
    }
  },
);
