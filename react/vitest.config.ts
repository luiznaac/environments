import { defineConfig } from "vitest/config";

// Only src/lib/** is under test — pure logic, no React rendering. See AGENTS.md: this scaffold
// deliberately doesn't set up component/render tests yet.
export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts"],
    environment: "node",
  },
});
