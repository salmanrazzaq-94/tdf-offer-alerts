import { appendFile } from "node:fs/promises";

const runLogPath = "data/run-log.jsonl";

export type RunLogEntry = {
  event: string;
  status: "success" | "failure" | "skipped";
  message?: string;
  shows?: number;
  performances?: number;
  newPerformances?: number;
  command?: string;
  updatesSeen?: number;
  notificationSent?: boolean;
};

export async function appendRunLog(entry: RunLogEntry): Promise<void> {
  const fullEntry = {
    timestamp: new Date().toISOString(),
    runUrl: process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null,
    actor: process.env.GITHUB_ACTOR ?? null,
    ...entry
  };

  await appendFile(runLogPath, `${JSON.stringify(fullEntry)}\n`);
}
