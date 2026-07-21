import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/server.ts", "src/contract.ts", "src/extension.ts", "src/cli.ts"],
  format: "esm",
  dts: true,
  external: ["@earendil-works/pi-coding-agent"],
});
