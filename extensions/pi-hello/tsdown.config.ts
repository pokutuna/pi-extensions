import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/hello.ts"],
  format: "esm",
});
