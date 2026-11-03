import { assert, it } from "@effect/vitest";
import type { Permission } from "@opencode/client/effect";
import { compileAgentPermissions, permissionEffect } from "./agentPermissions.ts";

const server = "t3-code-owned";
const profile: ReadonlyArray<Permission.Rule> = [
  { action: "*", resource: "*", effect: "allow" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "edit", resource: "/notes/*", effect: "allow" },
  { action: "t3-code-*", resource: "*", effect: "ask" },
  { action: "t3-code-*_t3_thread_read", resource: "*", effect: "allow" },
  { action: "t3-code-*_t3_thread_read", resource: "private", effect: "deny" },
  { action: "t3-code-*_t3_terminal_run", resource: "*", effect: "deny" },
];

it("keeps profile decisions and resource exceptions in full access without opening other threads", () => {
  const rules = compileAgentPermissions({
    profile,
    runtimeMode: "full-access",
    interactionMode: "default",
    mcpServerName: server,
    mcpToolNames: ["t3_thread_read", "t3_terminal_run"],
  });
  assert.strictEqual(permissionEffect(rules, "shell", "echo harmless"), "deny");
  assert.strictEqual(permissionEffect(rules, "edit", "/notes/safe.md"), "allow");
  assert.strictEqual(permissionEffect(rules, "edit", "/source/app.ts"), "deny");
  assert.strictEqual(permissionEffect(rules, `${server}_t3_thread_read`, "public"), "allow");
  assert.strictEqual(permissionEffect(rules, `${server}_t3_thread_read`, "private"), "deny");
  assert.strictEqual(permissionEffect(rules, `${server}_t3_terminal_run`, "echo harmless"), "deny");
  assert.strictEqual(permissionEffect(rules, "t3-code-foreign_t3_thread_read", "public"), "deny");
  assert.strictEqual(permissionEffect(rules, `${server}_new_tool`, "*"), "deny");
  assert.strictEqual(permissionEffect(rules, "subagent", "general"), "deny");
});

it("intersects supervised and plan ceilings with ordered profile permissions", () => {
  const input = { profile, mcpServerName: server, mcpToolNames: ["t3_thread_read"] };
  const supervised = compileAgentPermissions({
    ...input,
    runtimeMode: "approval-required",
    interactionMode: "default",
  });
  assert.strictEqual(permissionEffect(supervised, "shell", "echo harmless"), "deny");
  assert.strictEqual(permissionEffect(supervised, "edit", "/notes/safe.md"), "ask");
  assert.strictEqual(permissionEffect(supervised, "edit", "/source/app.ts"), "deny");
  const plan = compileAgentPermissions({
    ...input,
    runtimeMode: "full-access",
    interactionMode: "plan",
  });
  assert.strictEqual(permissionEffect(plan, "edit", "/notes/safe.md"), "deny");
  const reversed = compileAgentPermissions({
    ...input,
    profile: [...profile, { action: "edit", resource: "*", effect: "deny" }],
    runtimeMode: "full-access",
    interactionMode: "default",
  });
  assert.strictEqual(permissionEffect(reversed, "edit", "/notes/safe.md"), "deny");
});
