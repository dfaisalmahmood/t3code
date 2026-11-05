import type { ProviderOptionDescriptor } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyProviderOptionSelection } from "./providerOptions";

const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
  { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
  {
    id: "serviceTier",
    label: "Service tier",
    type: "select",
    currentValue: "default",
    options: [
      { id: "default", label: "Standard" },
      { id: "priority", label: "Fast" },
    ],
  },
];

describe("provider option changes", () => {
  it("retains a custom Agent absent from the catalog when changing another option", () => {
    for (const agent of ["mason", `mason@${"a".repeat(64)}`, "unknown-custom-role"]) {
      for (const change of [
        { id: "fastMode", value: true },
        { id: "serviceTier", value: "priority" },
      ]) {
        expect(
          applyProviderOptionSelection(descriptors, change, [{ id: "agent", value: agent }]),
        ).toEqual([
          { id: "fastMode", value: change.id === "fastMode" },
          { id: "serviceTier", value: change.id === "serviceTier" ? "priority" : "default" },
          { id: "agent", value: agent },
        ]);
      }
    }
  });
});
