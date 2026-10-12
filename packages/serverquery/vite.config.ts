import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: { index: resolve(__dirname, "src/index.ts") },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    rolldownOptions: {
      external: [/^node:/, /^@honeybbq\//],
    },
    target: "node20",
    sourcemap: true,
  },
  test: {
    name: "@honeybbq/teamspeak-serverquery",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
