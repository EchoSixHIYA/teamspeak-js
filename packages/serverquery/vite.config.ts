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
    // Readable output: class names stay in stack traces and inspect().
    minify: false,
  },
  test: {
    name: "@honeybbq/teamspeak-serverquery",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
