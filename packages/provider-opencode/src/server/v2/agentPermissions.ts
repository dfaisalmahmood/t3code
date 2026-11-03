import type { Permission } from "@opencode/client/effect";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

const matches = (pattern: string, value: string) =>
  new RegExp(
    `^${pattern
      .split(/([*?])/)
      .map((part) => (part === "*" ? ".*" : part === "?" ? "." : RegExp.escape(part)))
      .join("")}$`,
    "s",
  ).test(value);

export const permissionEffect = (
  rules: ReadonlyArray<Permission.Rule>,
  action: string,
  resource: string,
): Permission.Rule["effect"] =>
  rules.findLast((entry) => matches(entry.action, action) && matches(entry.resource, resource))
    ?.effect ?? "ask";

const bounded = (
  effect: Permission.Rule["effect"],
  ceiling: Permission.Rule["effect"],
): Permission.Rule["effect"] =>
  effect === "deny" || ceiling === "deny"
    ? "deny"
    : effect === "ask" || ceiling === "ask"
      ? "ask"
      : "allow";

export const compileAgentPermissions = (input: {
  readonly profile: ReadonlyArray<Permission.Rule>;
  readonly runtimeMode: ProviderAdapterV2RuntimePolicy["runtimeMode"];
  readonly interactionMode: ProviderAdapterV2RuntimePolicy["interactionMode"];
  readonly mcpServerName: string | null;
  readonly mcpToolNames: ReadonlyArray<string>;
}): ReadonlyArray<Permission.Rule> => {
  const project = (
    action: string,
    ceiling: Permission.Rule["effect"],
  ): ReadonlyArray<Permission.Rule> => [
    { action, resource: "*", effect: bounded("ask", ceiling) },
    ...input.profile
      .filter((entry) => matches(entry.action, action))
      .map((entry) => ({
        ...entry,
        action,
        effect: bounded(entry.effect, ceiling),
      })),
  ];
  return [
    ...input.profile,
    ...(input.runtimeMode === "full-access"
      ? []
      : [
          ...project("shell", "ask"),
          ...project("edit", input.runtimeMode === "auto-accept-edits" ? "allow" : "ask"),
          ...project("external_directory", "ask"),
        ]),
    ...(input.interactionMode === "plan"
      ? [{ action: "edit", resource: "*", effect: "deny" as const }]
      : []),
    // Native children cannot be restricted before their first tool by event-time updates.
    { action: "subagent", resource: "*", effect: "deny" },
    { action: "t3-code-*", resource: "*", effect: "deny" },
    ...(input.mcpServerName === null
      ? []
      : [...new Set(input.mcpToolNames)]
          .filter((name) => /^[a-zA-Z0-9_.-]+$/.test(name))
          .flatMap((name) => project(`${input.mcpServerName}_${name}`, "allow"))),
  ];
};
