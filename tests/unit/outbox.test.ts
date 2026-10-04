import { strict as assert } from "node:assert";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { ArtifactRegistry } from "../../src/artifacts/registry.js";
import { Outbox } from "../../src/telegram/outbox.js";
import { TelegramApiError, TelegramNetworkError, TelegramRateLimitError, type TelegramClient, type TgMessageId } from "../../src/telegram/api.js";
import { Logger } from "../../src/logging.js";

function makeOutbox(sendImpl: (method: string) => Promise<TgMessageId>) {
  const db = Database.open(":memory:");
  runMigrations(db);
  const artifacts = new ArtifactRegistry(db, join(tmpdir(), `pi-tg-artifacts-${Date.now()}`), new Logger({}, { toStderr: false }));
  const client = {
    sendMessage: async () => sendImpl("sendMessage"),
    sendPhoto: async () => sendImpl("sendPhoto"),
    sendDocument: async () => sendImpl("sendDocument"),
  } as unknown as TelegramClient;
  return { db, outbox: new Outbox(db, client, { getOwnerChatId: () => "100", artifacts, logger: new Logger({}, { toStderr: false }), minimumIntervalMs: 1 }) };
}

test("logical keys prevent duplicate enqueues", () => {
  const { db, outbox } = makeOutbox(async () => ({ message_id: 1 }));
  assert.equal(outbox.enqueue({ logicalKey: "job:1:final", kind: "text", payload: { text: "hi", variant: "final" } }), true);
  assert.equal(outbox.enqueue({ logicalKey: "job:1:final", kind: "text", payload: { text: "hi again", variant: "final" } }), false);
  assert.equal(outbox.countPending(), 1);
  db.close();
});

test("successful delivery marks the item sent", async () => {
  const { db, outbox } = makeOutbox(async () => ({ message_id: 55 }));
  outbox.enqueue({ logicalKey: "k1", kind: "text", payload: { text: "hi", variant: "final" } });
  await outbox.runOnce();
  const item = outbox.getByLogicalKey("k1")!;
  assert.equal(item.state, "sent");
  assert.equal(item.telegram_message_id, 55);
  db.close();
});

test("rate limits schedule a retry with retry_after", async () => {
  let calls = 0;
  const { db, outbox } = makeOutbox(async () => {
    calls += 1;
    if (calls === 1) throw new TelegramRateLimitError("slow down", 7);
    return { message_id: 1 };
  });
  outbox.enqueue({ logicalKey: "k2", kind: "text", payload: { text: "hi", variant: "final" } });
  await outbox.runOnce();
  // Retry is scheduled in the future; make it due and run again.
  db.prepare("UPDATE outbox SET next_attempt_at = NULL WHERE logical_key = 'k2'").run();
  await outbox.runOnce();
  const item = outbox.getByLogicalKey("k2")!;
  assert.equal(item.state, "sent");
  assert.equal(item.attempts, 1);
  db.close();
});

test("repeated network failures become delivery_unknown, not infinite retries", async () => {
  const { db, outbox } = makeOutbox(async () => {
    throw new TelegramNetworkError("connection reset");
  });
  outbox.enqueue({ logicalKey: "k3", kind: "text", payload: { text: "hi", variant: "final" } });
  await outbox.runOnce();
  db.prepare("UPDATE outbox SET next_attempt_at = NULL WHERE logical_key = 'k3'").run();
  await outbox.runOnce();
  const item = outbox.getByLogicalKey("k3")!;
  assert.equal(item.state, "delivery_unknown");
  assert.equal(item.delivery_unknown, 1);
  db.close();
});

test("permanent API errors fail without retry", async () => {
  const { db, outbox } = makeOutbox(async () => {
    throw new TelegramApiError(400, "bad request");
  });
  outbox.enqueue({ logicalKey: "k4", kind: "text", payload: { text: "hi", variant: "final" } });
  await outbox.runOnce();
  const item = outbox.getByLogicalKey("k4")!;
  assert.equal(item.state, "failed");
  db.close();
});
