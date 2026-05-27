import assert from "node:assert/strict";
import test from "node:test";
import { handleTelegram, sendMessage } from "../worker/telegram.js";
import { MemoryKV, env, response, withFetch } from "./worker-helpers.js";

test("unauthorized Telegram chats are ignored with a sanitized ingress log", async () => {
  const kv = new MemoryKV();

  await withFetch(async () => {
    throw new Error("Telegram send should not be called.");
  }, async () => {
    await handleTelegram({
      message: {
        text: "/offers",
        chat: { id: 999 }
      }
    }, env(kv), "https://worker.test/telegram");
  });

  const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{ trigger: string; status: string }>;
  assert.equal(logs.at(-1)?.trigger, "telegram:ignored");
  assert.equal(logs.at(-1)?.status, "skipped");
});

test("unknown authorized Telegram commands are logged without sending a message", async () => {
  const kv = new MemoryKV();

  await withFetch(async () => {
    throw new Error("Telegram send should not be called.");
  }, async () => {
    await handleTelegram({
      message: {
        text: "/unknown",
        chat: { id: 123 }
      }
    }, env(kv), "https://worker.test/telegram");
  });

  const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{ trigger: string; status: string }>;
  assert.equal(logs.at(-1)?.trigger, "telegram:unknown");
  assert.equal(logs.at(-1)?.status, "skipped");
});

test("help command logs ingress and sends the command list", async () => {
  const kv = new MemoryKV();
  const bodies: string[] = [];

  await withFetch(async (input: string | URL | Request, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return response('{"ok":true}', { status: 200, url: String(input instanceof Request ? input.url : input) });
  }, async () => {
    await handleTelegram({
      message: {
        text: "/help",
        chat: { id: 123 }
      }
    }, env(kv), "https://worker.test/telegram");
  });

  assert.match(bodies.join("\n"), /Commands: \/offers/);
  const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{ trigger: string; status: string }>;
  assert.equal(logs.at(-1)?.trigger, "telegram:/help");
  assert.equal(logs.at(-1)?.status, "success");
});

test("sendMessage surfaces Telegram API response bodies on failure", async () => {
  await withFetch(async () => response("telegram down", { status: 500 }), async () => {
    await assert.rejects(
      () => sendMessage(env(new MemoryKV()), "hello"),
      /Telegram send failed with 500: telegram down/
    );
  });
});
