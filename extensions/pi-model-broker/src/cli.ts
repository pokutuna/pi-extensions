#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadConfigFile } from "./config.ts";
import { MANIFEST_VERSION } from "./contract.ts";
import { startModelBroker } from "./server.ts";

interface CliOptions {
  config: string;
  host: string;
  port: number;
}

function usage(): string {
  return [
    "Usage: pi-model-broker serve --config FILE [--listen HOST:PORT]",
    "",
    "The default listen address is 127.0.0.1:0.",
  ].join("\n");
}

function parseListen(value: string): { host: string; port: number } {
  let host: string;
  let portValue: string;
  if (value.startsWith("[")) {
    const end = value.indexOf("]:");
    if (end === -1) throw new Error(`invalid --listen value: ${value}`);
    host = value.slice(1, end);
    portValue = value.slice(end + 2);
  } else {
    const separator = value.lastIndexOf(":");
    if (separator <= 0) throw new Error(`invalid --listen value: ${value}`);
    host = value.slice(0, separator);
    portValue = value.slice(separator + 1);
  }
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error(`invalid --listen port: ${portValue}`);
  return { host, port };
}

function parseArgs(argv: string[]): CliOptions {
  if (argv[0] !== "serve") throw new Error(usage());
  let config: string | undefined;
  let listen = { host: "127.0.0.1", port: 0 };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      config = argv[++index];
      if (config === undefined || config === "") throw new Error("--config requires a path");
    } else if (arg === "--listen") {
      const value = argv[++index];
      if (value === undefined) throw new Error("--listen requires HOST:PORT");
      listen = parseListen(value);
    } else if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    } else {
      throw new Error(`unknown argument ${arg}\n\n${usage()}`);
    }
  }
  if (config === undefined) throw new Error("--config is required");
  return { config, ...listen };
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const providers = await loadConfigFile(options.config);
  const broker = await startModelBroker({
    listen: { host: options.host, port: options.port },
    providers,
  });
  process.stdout.write(
    `${JSON.stringify({ event: "ready", url: broker.url, manifestVersion: MANIFEST_VERSION })}\n`,
  );

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await broker.close();
  };
  process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
  process.once("SIGINT", () => void stop().finally(() => process.exit(0)));
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined) {
  try {
    if (realpathSync(entrypoint) === realpathSync(fileURLToPath(import.meta.url))) {
      void runCli().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = 1;
      });
    }
  } catch {
    // An imported module or a not-yet-created entrypoint is not the CLI main module.
  }
}
