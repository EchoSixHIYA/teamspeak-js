import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: resolve(__dirname, "src/index.ts"),
        internal: resolve(__dirname, "src/internal.ts"),
      },
      formats: ["es"],
      fileName: (_format, name) => `${name}.js`,
    },
    target: "node20",
    sourcemap: true,
  },
  test: {
    name: "@honeybbq/teamspeak-core",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
