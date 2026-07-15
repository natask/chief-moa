import { fileURLToPath, pathToFileURL } from "node:url";
import { cli, ServerOptions } from "@livekit/agents";

export function runWorkerCli(
  runApp: (options: ServerOptions) => void = cli.runApp,
  agentUrl = new URL("./agent.js", import.meta.url).href,
): void {
  runApp(new ServerOptions({ agent: fileURLToPath(agentUrl) }));
}

export function isMain(moduleUrl: string, argv1: string | undefined): boolean {
  return Boolean(argv1) && moduleUrl === pathToFileURL(argv1 as string).href;
}

if (isMain(import.meta.url, process.argv[1])) {
  runWorkerCli();
}
