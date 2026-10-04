import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Database } from "../../src/storage/database.js";
import { runMigrations } from "../../src/storage/migrations.js";
import { JobRepository } from "../../src/jobs/repository.js";
import { Authorizer, PairingService, generatePairingCode, hashPairingCode, verifyPairingCode } from "../../src/telegram/auth.js";

test("pairing code hashing verifies correctly", () => {
  const code = generatePairingCode();
  assert.ok(code.length >= 20);
  const hash = hashPairingCode(code);
  assert.equal(verifyPairingCode(code, hash), true);
  assert.equal(verifyPairingCode("wrong", hash), false);
});

test("authorizer requires exact numeric owner user and chat", () => {
  const authorizer = new Authorizer(() => ({ ownerUserId: "42", ownerChatId: "42" }));
  const good = { message_id: 1, date: 0, chat: { id: 42, type: "private" as const }, from: { id: 42, is_bot: false, first_name: "Owner" } };
  assert.equal(authorizer.checkMessage(good).ok, true);
  assert.equal(authorizer.checkMessage({ ...good, chat: { id: 99, type: "private" } }).reason, "wrong_chat");
  assert.equal(authorizer.checkMessage({ ...good, from: { id: 7, is_bot: false, first_name: "Other" } }).reason, "wrong_user");
  assert.equal(authorizer.checkMessage({ ...good, chat: { id: 42, type: "group" } }).reason, "group_or_channel");
});

test("unpaired authorizer rejects everything", () => {
  const authorizer = new Authorizer(() => null);
  const good = { message_id: 1, date: 0, chat: { id: 42, type: "private" as const }, from: { id: 42, is_bot: false, first_name: "Owner" } };
  assert.equal(authorizer.checkMessage(good).reason, "unpaired");
});

test("pairing service accepts only the active code", () => {
  const db = Database.open(":memory:");
  runMigrations(db);
  const repository = new JobRepository(db);
  const pairing = new PairingService({ repository });
  const code = generatePairingCode();
  pairing.startPairing(code);
  const wrong = pairing.submitPairingCode("nope", { id: 5, is_bot: false, first_name: "X" }, "5");
  assert.equal(wrong.ok, false);
  const right = pairing.submitPairingCode(code, { id: 5, is_bot: false, first_name: "X" }, "5");
  assert.equal(right.ok, true);
  const candidate = pairing.getPendingCandidate();
  assert.equal(candidate?.userId, "5");
  assert.equal(candidate?.chatId, "5");
  const accepted = pairing.acceptCandidate();
  assert.equal(accepted?.userId, "5");
  assert.equal(repository.isPairingMode(), false);
  // After acceptance the code can no longer be used.
  assert.equal(pairing.submitPairingCode(code, { id: 5, is_bot: false, first_name: "X" }, "5").ok, false);
});
