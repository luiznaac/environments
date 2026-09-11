import { describe, expect, it } from "vitest";
import { formatHealthStatus } from "./format.ts";

describe("formatHealthStatus", () => {
  it("formats a healthy result", () => {
    expect(formatHealthStatus(true)).toBe("healthy");
  });

  it("formats an unhealthy result", () => {
    expect(formatHealthStatus(false)).toBe("unhealthy");
  });
});
