import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getPromptControlledTraits, getTraitSelectChange } from "./modelTraits.ts";

const effort: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
  currentValue: "low",
};
const tier: Extract<ProviderOptionDescriptor, { type: "select" }> = {
  id: "serviceTier",
  label: "Service tier",
  type: "select",
  options: [
    { id: "default", label: "Standard" },
    { id: "priority", label: "Fast" },
  ],
  currentValue: "default",
};

describe("trait selection changes", () => {
  it("keeps a custom Agent without a catalog descriptor when changing effort or tier", () => {
    const descriptors = [effort, tier];
    for (const agent of ["mason", `mason@${"a".repeat(64)}`, "unknown-custom-role"]) {
      for (const [descriptor, value, expected] of [
        [
          effort,
          "high",
          [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "default" },
            { id: "agent", value: agent },
          ],
        ],
        [
          tier,
          "priority",
          [
            { id: "reasoningEffort", value: "low" },
            { id: "serviceTier", value: "priority" },
            { id: "agent", value: agent },
          ],
        ],
      ] as const) {
        const selected = {
          ...getPromptControlledTraits(descriptors, "solve it"),
          descriptors,
          modelOptions: [{ id: "agent", value: agent }],
        };
        expect(getTraitSelectChange(selected, descriptor, "solve it", value)).toEqual({
          prompt: "solve it",
          modelOptions: expected,
        });
      }
    }
  });

  it("dispatches a bare target Agent only after explicit reselection and keeps effort and tier", () => {
    const qualifiedAgent = `mason@${"a".repeat(64)}`;
    const agent: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [
        { id: "default", label: "Default" },
        { id: "mason", label: "Mason" },
      ],
      currentValue: qualifiedAgent,
    };
    const descriptors = [effort, tier, agent];
    const currentOptions = [
      { id: "reasoningEffort", value: "low" },
      { id: "serviceTier", value: "default" },
      { id: "agent", value: qualifiedAgent },
    ];
    const selected = {
      ...getPromptControlledTraits(descriptors, "solve it"),
      descriptors,
      modelOptions: currentOptions,
    };
    const unchangedAgent = getTraitSelectChange(selected, tier, "solve it", "priority");
    expect(unchangedAgent?.modelOptions).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "serviceTier", value: "priority" },
      { id: "agent", value: qualifiedAgent },
    ]);
    const reprioritizedDescriptors = descriptors.map((descriptor) =>
      descriptor.id === "serviceTier" ? { ...descriptor, currentValue: "priority" } : descriptor,
    );
    const reselected = getTraitSelectChange(
      {
        ...getPromptControlledTraits(reprioritizedDescriptors, "solve it"),
        descriptors: reprioritizedDescriptors,
        modelOptions: unchangedAgent?.modelOptions,
      },
      agent,
      "solve it",
      "mason",
    );
    expect(reselected?.modelOptions).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "serviceTier", value: "priority" },
      { id: "agent", value: "mason" },
    ]);
  });

  it("lets an explicit Agent Default choice replace the custom role", () => {
    const agent: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "agent",
      label: "Agent",
      type: "select",
      options: [{ id: "default", label: "Default" }],
      currentValue: "missing-role",
    };
    const descriptors = [effort, agent];
    expect(
      getTraitSelectChange(
        {
          ...getPromptControlledTraits(descriptors, "solve it"),
          descriptors,
          modelOptions: [{ id: "agent", value: "missing-role" }],
        },
        agent,
        "solve it",
        "default",
      )?.modelOptions,
    ).toEqual([
      { id: "reasoningEffort", value: "low" },
      { id: "agent", value: "default" },
    ]);
  });
});
