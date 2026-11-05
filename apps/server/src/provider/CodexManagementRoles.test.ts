import { assert, it } from "@effect/vitest";
import {
  compileCodexManagementRole,
  verifyCodexManagementRuntimeConfig,
  codexManagementRoleConfig,
} from "./CodexManagementRoles.ts";

const instructions = "# A role\nKeep authority bounded.\n";
const permission = {
  "*": "ask",
  read: "allow",
  glob: "allow",
  grep: "allow",
  list: "allow",
  webfetch: "allow",
  edit: "deny",
  bash: "deny",
  task: "deny",
  "t3-code-*_t3_thread_read": "allow",
  "t3-code-*_t3_terminal_*": "deny",
  "t3-code-*_delegate_task": "allow",
};
const envelope = (name = "example") =>
  `name = ${JSON.stringify(name)}\ndescription = "A role"\ndeveloper_instructions = ${JSON.stringify(instructions)}\n`;
const companion = (policy: unknown = permission) =>
  `---\n${JSON.stringify({ description: "A role", mode: "primary", permission: policy })}\n---\n${instructions}`;

it("compiles only explicit policy grants and denies tools that can escape the role ceiling", () => {
  const role = compileCodexManagementRole({
    id: "example",
    envelope: envelope(),
    companion: companion(),
  });
  assert.deepEqual(role.allowedTools, ["delegate_task", "t3_thread_read"]);
  assert.include(role.instructions, instructions);
  assert.include(role.limitations, "delegation");
  assert.equal(codexManagementRoleConfig(role)["features.shell_tool"], false);
  assert.equal(codexManagementRoleConfig(role)["features.unified_exec"], undefined);
  assert.equal(codexManagementRoleConfig(role)["features.code_mode_host"], undefined);
  assert.equal(codexManagementRoleConfig(role)["features.multi_agent"], false);
  assert.equal(codexManagementRoleConfig(role)["agents.enabled"], false);
});

it.each([
  { envelope: envelope("different"), companion: companion() },
  { envelope: envelope(), companion: "" },
  { envelope: envelope(), companion: companion({ ...permission, edit: "allow" }) },
  { envelope: envelope(), companion: companion({ ...permission, unknown: "allow" }) },
  { envelope: envelope(), companion: companion({ ...permission, toString: "allow" }) },
  { envelope: envelope() + 'sandbox_mode = "danger-full-access"\n', companion: companion() },
  { envelope: envelope(), companion: companion().replace(instructions, "different") },
  {
    envelope: envelope().replace(JSON.stringify(instructions), JSON.stringify("x".repeat(200_000))),
    companion: companion(),
  },
])("rejects unproven or inconsistent role authority %#", (input) => {
  assert.throws(() => compileCodexManagementRole({ id: "example", ...input }));
});

it("reduces shell ask to deny and reports the lost capability", () => {
  const role = compileCodexManagementRole({
    id: "example",
    envelope: envelope(),
    companion: companion({ ...permission, bash: "ask" }),
  });
  assert.include(role.limitations, "Shell approval");
  assert.equal(codexManagementRoleConfig(role)["features.shell_tool"], false);
});

it("rejects inherited MCP registrations and ineffective native restrictions before adoption", () => {
  const role = compileCodexManagementRole({
    id: "example",
    envelope: envelope(),
    companion: companion(),
  });
  const config = {
    developer_instructions: role.instructions,
    approval_policy: "never",
    sandbox_mode: "read-only",
    web_search: "disabled",
    features: {
      shell_tool: false,
      unified_exec: false,
      multi_agent: false,
      apps: false,
      goals: false,
      browser_use: false,
      browser_use_external: false,
      browser_use_full_cdp_access: false,
      computer_use: false,
      image_generation: false,
      in_app_browser: false,
      multi_agent_v2: false,
      code_mode: false,
      code_mode_host_grpc: false,
      remote_plugin: false,
      deferred_executor: false,
      plugins: false,
    },
    agents: { enabled: false },
    mcp_servers: {},
  };
  const features = [
    ...Object.entries(config.features).map(([name, enabled]) => ({
      name,
      enabled: name === "unified_exec" ? true : enabled,
    })),
    { name: "code_mode_host", enabled: true },
  ];
  assert.doesNotThrow(() => verifyCodexManagementRuntimeConfig({ config }, role, [], features));
  assert.throws(() =>
    verifyCodexManagementRuntimeConfig(
      { config },
      role,
      [],
      features.filter((feature) => feature.name !== "code_mode_host"),
    ),
  );
  assert.throws(() =>
    verifyCodexManagementRuntimeConfig({ config }, role, [], [...features, features[0]!]),
  );
  assert.throws(() =>
    verifyCodexManagementRuntimeConfig(
      { config },
      role,
      [],
      features.map((feature) =>
        feature.name === "code_mode_host" ? { ...feature, enabled: false } : feature,
      ),
    ),
  );
  for (const rejected of [
    { ...config, developer_instructions: "old role" },
    { ...config, features: { ...config.features, shell_tool: true } },
    { ...config, features: { ...config.features, code_mode_host: false } },
    { ...config, mcp_servers: { foreign: { enabled: true } } },
    { ...config, mcp_servers: { "t3-code": { url: "http://other-server/mcp" } } },
  ])
    assert.throws(() =>
      verifyCodexManagementRuntimeConfig({ config: rejected }, role, [], features),
    );
});

it.each(["allow", "deny"] as const)("keeps explicit PR watcher grants bounded (%s)", (decision) => {
  const role = compileCodexManagementRole({
    id: "example",
    envelope: envelope(),
    companion: companion({
      ...permission,
      "t3-code-*_link_pull_request": decision,
      "t3-code-*_watch_pull_request": decision,
      "t3-code-*_unwatch_pull_request": decision,
    }),
  });
  assert.deepEqual(
    role.allowedTools,
    decision === "allow"
      ? [
          "delegate_task",
          "link_pull_request",
          "t3_thread_read",
          "unwatch_pull_request",
          "watch_pull_request",
        ]
      : ["delegate_task", "t3_thread_read"],
  );
});
