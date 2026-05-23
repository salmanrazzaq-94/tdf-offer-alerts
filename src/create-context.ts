import Browserbase from "@browserbasehq/sdk";
import { readBrowserbaseProjectEnv } from "./env.js";

async function main(): Promise<void> {
  const env = readBrowserbaseProjectEnv();
  const bb = new Browserbase({ apiKey: env.browserbaseApiKey });
  const context = await bb.contexts.create({
    projectId: env.browserbaseProjectId
  });

  console.log(context.id);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
