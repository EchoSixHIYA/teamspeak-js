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
      // Dependencies stay dependencies. Bundling @noble/curves copied it into
      // this package, where the application can neither dedupe nor update it.
      external: [/^node:/, /^@noble\//, /^@honeybbq\//],
    },
    target: "node22",
    sourcemap: true,
    // Readable output: class names stay in stack traces and inspect().
    minify: false,
  },
  test: {
    name: "@honeybbq/teamspeak-client",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
