// @effect-diagnostics nodeBuiltinImport:off -- The role selection persists a synchronous content digest across native process restarts.
import * as NodeCrypto from "node:crypto";
import type { ModelSelection, ServerProviderModel } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

const MAX_ROLE_BYTES = 128_000;
const RoleEnvelope = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  developer_instructions: Schema.NonEmptyString,
});
const Companion = Schema.Struct({
  description: Schema.NonEmptyString,
  mode: Schema.Literal("primary"),
  permission: Schema.Record(Schema.String, Schema.Literals(["allow", "ask", "deny"])),
});
const decodeEnvelope = Schema.decodeUnknownSync(RoleEnvelope);
const decodeCompanion = Schema.decodeUnknownSync(Companion, { onExcessProperty: "error" });
const SUPPORTED_TOOLS = new Set([
  "link_pull_request",
  "watch_pull_request",
  "unwatch_pull_request",
  "t3_pending_request",
  "t3_thread_organize",
  "delegate_task",
  "task_cancel",
  "t3_thread_send",
  "t3_thread_snooze",
  "t3_thread_launch",
  "t3_thread_interrupt",
  "t3_thread_update",
  "orchestrator_capabilities",
  "t3_environment_read",
  "t3_project_list",
  "t3_project_read",
  "t3_thread_list",
  "t3_thread_search",
  "t3_worktree_list",
  "t3_worktree_status",
  "list_thread_pull_requests",
  "read_pull_request_guide",
  "list_scheduled_tasks",
  "task_status",
  "t3_thread_read",
]);
const KNOWN_T3_RULES = new Set([
  ...SUPPORTED_TOOLS,
  "t3_pending_request",
  "t3_thread_organize",
  "link_pull_request",
  "unwatch_pull_request",
  "watch_pull_request",
  "t3_terminal_*",
  "t3_project_delete",
  "t3_project_clone",
  "t3_environment_preferences_update",
  "t3_thread_configure",
  "t3_thread_merge_back",
  "t3_worktree_handoff",
  "create_threads",
  "schedule_task",
  "update_scheduled_task",
  "run_scheduled_task_now",
  "delete_scheduled_task",
]);
const BASE_PERMISSIONS: Readonly<Record<string, string>> = {
  "*": "ask",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  webfetch: "allow",
  edit: "deny",
  task: "deny",
};

export class CodexManagementRoleError extends Schema.TaggedError<CodexManagementRoleError>()(
  "CodexManagementRoleError",
  {
    reason: Schema.Literals([
      "invalid-profile",
      "missing-profile",
      "changed-profile",
      "unsupported-runtime",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `Codex management role cannot run (${this.reason}). Check its installed envelope and permission companion, or use OpenCode.`;
  }
}

export interface CodexManagementRole {
  readonly id: string;
  readonly selectionId: string;
  readonly description: string;
  readonly instructions: string;
  readonly allowedTools: ReadonlyArray<string>;
  readonly limitations: string;
  readonly revision: string;
}

export function compileCodexManagementRole(input: {
  readonly id: string;
  readonly envelope: string;
  readonly companion: string;
}): CodexManagementRole {
  if (
    !/^[a-z][a-z0-9_-]{0,63}$/.test(input.id) ||
    ["default", "build", "plan"].includes(input.id) ||
    Buffer.byteLength(input.envelope) > MAX_ROLE_BYTES ||
    Buffer.byteLength(input.companion) > MAX_ROLE_BYTES
  )
    throw new CodexManagementRoleError({ reason: "invalid-profile" });
  try {
    const fields: Record<string, unknown> = {};
    for (const line of input.envelope.trim().split("\n")) {
      const match = /^(name|description|developer_instructions) = (".*")\s*$/u.exec(line);
      if (!match || Object.hasOwn(fields, match[1]!)) throw new Error("Unsupported envelope");
      fields[match[1]!] = JSON.parse(match[2]!);
    }
    const envelope = decodeEnvelope(fields);
    if (!envelope.developer_instructions.isWellFormed()) throw new Error("Malformed Unicode");
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/u.exec(input.companion);
    if (!match) throw new Error("Missing policy companion");
    const companion = decodeCompanion(JSON.parse(match[1]!));
    if (
      envelope.name !== input.id ||
      companion.description !== envelope.description ||
      match[2]!.trim() !== envelope.developer_instructions.trim()
    )
      throw new Error("Mismatched profile");
    for (const [key, value] of Object.entries(BASE_PERMISSIONS))
      if (companion.permission[key] !== value) throw new Error("Unsupported ceiling");
    if (companion.permission.bash !== "ask" && companion.permission.bash !== "deny")
      throw new Error("Unsupported shell ceiling");
    const allowedTools: string[] = [];
    for (const [key, value] of Object.entries(companion.permission)) {
      if (Object.hasOwn(BASE_PERMISSIONS, key) || key === "bash") continue;
      const tool = /^t3-code-\*_([a-z][a-z0-9_]*\*?)$/u.exec(key)?.[1];
      if (!tool || !KNOWN_T3_RULES.has(tool) || (tool.includes("*") && value !== "deny"))
        throw new Error("Unsupported policy rule");
      if (value === "allow" && SUPPORTED_TOOLS.has(tool)) allowedTools.push(tool);
    }
    const limitations =
      "Management roles require qualified Codex 0.166.0 and use a conservative read-only ceiling. Shell approval, native file/search commands, web fetching, and non-T3 tools are unavailable. Only explicitly granted, supported T3 tools are available. Native children are disabled; explicit T3 delegation grants still permit dispatch to workers with their own authority. Delegation inherits the Agent with inherited model options; explicitly choose Agent Default for implementation workers while retaining their requested effort and tier. Unmapped grants are unavailable. Native patch writes are blocked by the sandbox; the patch tool may remain visible. Use OpenCode for the full companion policy.";
    return {
      id: input.id,
      selectionId: `${input.id}@${NodeCrypto.createHash("sha256").update(input.envelope).update("\0").update(input.companion).digest("hex")}`,
      description: envelope.description,
      instructions: `${envelope.developer_instructions}\n\n${limitations}`,
      allowedTools: allowedTools.sort(),
      limitations,
      revision: `${input.envelope}\0${input.companion}`,
    };
  } catch (cause) {
    throw new CodexManagementRoleError({ reason: "invalid-profile", cause });
  }
}

export const codexManagementRoleConfig = (
  _role: CodexManagementRole,
): Readonly<Record<string, Schema.Json>> => ({
  "features.shell_tool": false,
  "features.multi_agent": false,
  "features.apps": false,
  "features.plugins": false,
  "features.goals": false,
  "features.browser_use": false,
  "features.browser_use_external": false,
  "features.browser_use_full_cdp_access": false,
  "features.computer_use": false,
  "features.image_generation": false,
  "features.in_app_browser": false,
  "features.multi_agent_v2": false,
  "features.code_mode": false,
  "features.code_mode_host_grpc": false,
  "features.remote_plugin": false,
  "features.deferred_executor": false,
  "agents.enabled": false,
  approval_policy: "never",
  sandbox_mode: "read-only",
  web_search: "disabled",
});

export const codexManagementRoleId = (selection: ModelSelection) => {
  const entries = selection.options?.filter((option) => option.id === "agent") ?? [];
  if (entries.length > 1 || (entries.length === 1 && typeof entries[0]!.value !== "string"))
    throw new CodexManagementRoleError({ reason: "invalid-profile" });
  const id = getModelSelectionStringOptionValue(selection, "agent");
  return id === "default" || id === "build" || id === "plan" ? undefined : id;
};

export const loadCodexManagementRoles = Effect.fn("loadCodexManagementRoles")(function* (input: {
  readonly homePath?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostHome = yield* HostProcess.HomeDirectory;
  const home = input.environment?.HOME || hostHome;
  const codexHome = expandHomePath(
    input.homePath?.trim() || input.environment?.CODEX_HOME?.trim() || path.join(home, ".codex"),
    home,
  );
  const companionHome = input.environment?.XDG_CONFIG_HOME || path.join(home, ".config");
  const directory = path.join(codexHome, "agents");
  if (!(yield* fs.exists(directory))) return [];
  const names = yield* fs.readDirectory(directory);
  return yield* Effect.forEach(names.filter((name) => name.endsWith(".toml")).sort(), (name) =>
    Effect.gen(function* () {
      const id = name.slice(0, -5);
      const readBounded = Effect.fn("CodexManagementRoles.readBounded")(function* (file: string) {
        const stat = yield* fs.stat(file);
        if (Number(stat.size) > MAX_ROLE_BYTES)
          return yield* new CodexManagementRoleError({ reason: "invalid-profile" });
        return yield* fs.readFileString(file);
      });
      const envelope = yield* readBounded(path.join(directory, name));
      const companion = yield* readBounded(
        path.join(companionHome, "opencode", "agents", `${id}.md`),
      );
      return yield* Effect.try({
        try: () => compileCodexManagementRole({ id, envelope, companion }),
        catch: (cause) => new CodexManagementRoleError({ reason: "invalid-profile", cause }),
      });
    }).pipe(Effect.option),
  ).pipe(Effect.map((roles) => roles.flatMap(Option.toArray)));
});

export function withCodexManagementRoleOptions(
  models: ReadonlyArray<ServerProviderModel>,
  roles: ReadonlyArray<CodexManagementRole>,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (
      roles.length === 0 &&
      !model.capabilities?.optionDescriptors?.some((option) => option.id === "agent")
    )
      return model;
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: [
          ...(model.capabilities?.optionDescriptors ?? []).filter(
            (option) => option.id !== "agent",
          ),
          ...(roles.length === 0
            ? []
            : [
                {
                  id: "agent",
                  label: "Agent",
                  type: "select" as const,
                  description: roles[0]!.limitations,
                  currentValue: "default",
                  options: [
                    { id: "default", label: "Default", isDefault: true },
                    ...roles.map((role) => ({
                      id: role.selectionId,
                      label: role.id,
                      description: `${role.description} ${role.limitations}`,
                    })),
                  ],
                },
              ]),
        ],
      },
    };
  });
}

const NativeMcpServers = Schema.Struct({
  config: Schema.Struct({
    mcp_servers: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    ),
  }),
});
const decodeNativeMcpServers = Schema.decodeUnknownSync(NativeMcpServers);

export function codexManagementMcpIsolation(response: unknown): ReadonlyArray<string> {
  try {
    const servers = Object.keys(decodeNativeMcpServers(response).config.mcp_servers ?? {});
    if (
      servers.length > 64 ||
      servers.some(
        (name) => !/^[a-zA-Z0-9_-]+$/.test(name) || name === "t3-code" || name === "t3-code-direct",
      )
    )
      throw new Error("Unsupported inherited server identity");
    return servers.sort();
  } catch (cause) {
    throw new CodexManagementRoleError({ reason: "unsupported-runtime", cause });
  }
}

const NativeRoleConfig = Schema.Struct({
  config: Schema.Struct({
    developer_instructions: Schema.String,
    approval_policy: Schema.Literal("never"),
    sandbox_mode: Schema.Literal("read-only"),
    web_search: Schema.Literal("disabled"),
    features: Schema.Struct({
      shell_tool: Schema.Literal(false),
      code_mode_host: Schema.optional(Schema.Literal(true)),
      multi_agent: Schema.Literal(false),
      apps: Schema.Literal(false),
      goals: Schema.Literal(false),
      browser_use: Schema.Literal(false),
      browser_use_external: Schema.Literal(false),
      browser_use_full_cdp_access: Schema.Literal(false),
      computer_use: Schema.Literal(false),
      image_generation: Schema.Literal(false),
      in_app_browser: Schema.Literal(false),
      multi_agent_v2: Schema.Literal(false),
      code_mode: Schema.Literal(false),
      code_mode_host_grpc: Schema.Literal(false),
      remote_plugin: Schema.Literal(false),
      deferred_executor: Schema.Literal(false),
      plugins: Schema.Literal(false),
    }),
    agents: Schema.Struct({ enabled: Schema.Literal(false) }),
    mcp_servers: Schema.optional(
      Schema.Record(Schema.String, Schema.Struct({ enabled: Schema.optional(Schema.Boolean) })),
    ),
  }),
});
const decodeNativeRoleConfig = Schema.decodeUnknownSync(NativeRoleConfig);

export function verifyCodexManagementRuntimeConfig(
  response: unknown,
  role: CodexManagementRole,
  isolatedMcpServers: ReadonlyArray<string> = [],
  nativeFeatures: ReadonlyArray<{ readonly name: string; readonly enabled: boolean }> = [],
): void {
  try {
    const { config } = decodeNativeRoleConfig(response);
    const features = new Map<string, boolean>();
    for (const feature of nativeFeatures) {
      if (features.has(feature.name)) throw new Error("Duplicate native feature");
      features.set(feature.name, feature.enabled);
    }
    if (
      features.get("code_mode_host") !== true ||
      Object.keys(codexManagementRoleConfig(role))
        .filter((key) => key.startsWith("features."))
        .some((key) => features.get(key.slice("features.".length)) !== false)
    )
      throw new Error("Unqualified native feature state");
    if (
      config.developer_instructions !== role.instructions ||
      Object.entries(config.mcp_servers ?? {}).some(
        ([name, value]) => value.enabled !== false && !isolatedMcpServers.includes(name),
      )
    )
      throw new Error("Unqualified inherited capability");
  } catch (cause) {
    throw new CodexManagementRoleError({ reason: "unsupported-runtime", cause });
  }
}
