import assert from "node:assert/strict";
import test from "node:test";
import { handleTelegram, sendMessage } from "../worker/telegram.js";
import { MemoryKV, env, response, sampleOffers, withFetch } from "./worker-helpers.js";

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

test("help command logs Telegram response failures", async () => {
  const kv = new MemoryKV();

  await withFetch(async () => response("telegram down", { status: 500 }), async () => {
    await handleTelegram({
      message: {
        text: "/help",
        chat: { id: 123 }
      }
    }, env(kv), "https://worker.test/telegram");
  });

  const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
    trigger: string;
    status: string;
    steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
  }>;
  const run = logs.at(-1);
  assert.equal(run?.trigger, "telegram:/help");
  assert.equal(run?.status, "failure");
  const sendStep = run?.steps.find((step) => step.name === "send-telegram-message");
  assert.equal(sendStep?.status, "failure");
  assert.match(String(sendStep?.details?.["message"]), /telegram down/);
});

test("offers command logs successful Telegram command runs", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");

  await withFetch(tdfAndTelegramFetch(), () => runTelegramCommand(kv, "/offers"));

  const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
    event: string;
    trigger: string;
    status: string;
    steps: Array<{ name: string; status: string }>;
  }>;
  const run = logs.at(-1);
  assert.equal(run?.event, "command");
  assert.equal(run?.trigger, "telegram:/offers");
  assert.equal(run?.status, "success");
  assert.ok(run?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-summary:success"));
  assert.ok(run?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-document:success"));
});

test("status command logs Telegram send failures as command failures", async () => {
  const kv = new MemoryKV();
  await kv.put("TDF_COOKIE", "TNEW=old; .TDFCustomOfferings.Session=session");

  await withFetch(tdfAndTelegramFetch(500, "telegram down"), () => runTelegramCommand(kv, "/status"));

  const logs = JSON.parse(kv.values.get("RUN_LOGS") ?? "[]") as Array<{
    trigger: string;
    status: string;
    steps: Array<{ name: string; status: string; details?: Record<string, unknown> }>;
  }>;
  const run = logs.at(-1);
  assert.equal(run?.trigger, "telegram:/status");
  assert.equal(run?.status, "failure");
  assert.ok(run?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-status:failure"));
  assert.ok(run?.steps.some((step) => `${step.name}:${step.status}` === "send-telegram-failure:failure"));
});

test("sendMessage surfaces Telegram API response bodies on failure", async () => {
  await withFetch(async () => response("telegram down", { status: 500 }), async () => {
    await assert.rejects(
      () => sendMessage(env(new MemoryKV()), "hello"),
      /Telegram send failed with 500: telegram down/
    );
  });
});

function runTelegramCommand(kv: MemoryKV, text: string): Promise<void> {
  return handleTelegram({
    message: {
      text,
      chat: { id: 123 }
    }
  }, env(kv), "https://worker.test/telegram");
}

function tdfAndTelegramFetch(telegramStatus = 200, telegramBody = "{\"ok\":true}"): typeof fetch {
  return async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://my.tdf.org/") {
      return response("<html>Events My Account</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url: "https://my.tdf.org/events"
      });
    }
    if (url.includes("/TDFCustomOfferings/Current?handler=Performances")) {
      return response(JSON.stringify(sampleOffers), {
        status: 200,
        headers: { "content-type": "application/json" },
        url
      });
    }
    if (url.includes("/TDFCustomOfferings/Current")) {
      return response("<html>Current Offers Logged in as Test LOG OUT</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
        url
      });
    }
    if (url.includes("api.telegram.org")) {
      return response(telegramBody, { status: telegramStatus, url });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
}
