import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      const name = args.trim();
      ctx.ui.notify(name ? `Hello, ${name}!` : "Hello!", "info");
    },
  });
}
