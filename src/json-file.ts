import { readFile, writeFile } from "node:fs/promises";

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

export async function writeJsonFile<T>(path: string, value: T): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
