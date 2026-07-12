import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  // Provided by the pi runtime at extension load time; must not be bundled.
  external: ["@earendil-works/pi-coding-agent"],
});
