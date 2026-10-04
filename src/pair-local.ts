/**
 * Local pairing flow. Run with `npm run pair`.
 *
 * - Stores the dedicated bot token with DPAPI (never through a command line).
 * - Verifies getMe and refuses to fight an existing webhook silently.
 * - Displays a 128-bit pairing code; the owner sends `/start <code>` in the
 *   bot's private chat; the owner explicitly accepts the candidate locally.
 */
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { rmSync } from "node:fs";
import { dataPaths, defaultConfigPath, ensureDataDirs, loadConfig, saveConfigAtomic, validateConfig, type AppConfig } from "./config.js";
import { Logger } from "./logging.js";
import { Database } from "./storage/database.js";
import { runMigrations } from "./storage/migrations.js";
import { JobRepository } from "./jobs/repository.js";
import { createSecretStore, DpapiSecretStore } from "./platform/secrets.js";
import { PairingService, generatePairingCode, PAIRING_CODE_TTL_MS } from "./telegram/auth.js";
import { TelegramClient } from "./telegram/api.js";
import { readLockInfo } from "./platform/lockfile.js";
import { parseCommandText } from "./telegram/commands.js";

function parseArgs(argv: string[]): { configPath: string; tokenFromStdin: boolean } {
  let configPath = defaultConfigPath();
  let tokenFromStdin = false;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--config" && argv[index + 1]) {
      configPath = argv[index + 1] as string;
      index += 1;
    } else if (argv[index] === "--token-stdin") {
      tokenFromStdin = true;
    }
  }
  return { configPath, tokenFromStdin };
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8").trim();
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) return await readAllStdin();
  return await new Promise<string>((resolvePromise) => {
    process.stderr.write(question);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup();
          process.stderr.write("\n");
          resolvePromise(value);
          return;
        }
        if (char === "\u0003") {
          cleanup();
          process.exit(130);
        }
        if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= " ") {
          value += char;
          process.stderr.write("*");
        }
      }
    };
    const cleanup = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
    };
    stdin.on("data", onData);
  });
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolvePromise) => rl.question(`${question} [y/N] `, resolvePromise));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const BOT_TOKEN_PATTERN = /^\d{6,12}:[A-Za-z0-9_-]{25,}$/;

function sanitizeToken(raw: string): string {
  return raw.trim().replace(/^['"]+|['"]+$/g, "").trim();
}

async function resolveToken(config: AppConfig, options: { tokenFromStdin: boolean }): Promise<{ token: string; source: "env" | "store" | "prompt" }> {
  if (process.env.PI_TG_BOT_TOKEN) return { token: process.env.PI_TG_BOT_TOKEN, source: "env" };
  const store = createSecretStore(dataPaths(config).secretsDir);
  const existing = await store.get(config.telegram.tokenSecretName);
  if (existing) return { token: existing, source: "store" };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = options.tokenFromStdin ? await readAllStdin() : await promptHidden(attempt === 0 ? "Bot token (hidden, from BotFather /newbot): " : "Bot token (try again): ");
    const token = sanitizeToken(raw);
    if (!token) {
      console.log("No token entered.");
      continue;
    }
    if (!BOT_TOKEN_PATTERN.test(token)) {
      console.log("That does not look like a BotFather token (expected <digits>:<letters/digits/-/_>). Copy the full token after 'Use this token to access the HTTP API:'.");
      continue;
    }
    return { token, source: "prompt" };
  }
  throw new Error("No usable bot token provided after three attempts.");
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));
  let config: AppConfig;
  try {
    config = loadConfig(options.configPath);
  } catch (error) {
    console.error(`Configuration error: ${(error as Error).message}`);
    console.error(`Copy config.example.json to ${options.configPath}, edit the paths, and run again.`);
    return 2;
  }
  const paths = dataPaths(config);
  ensureDataDirs(paths);
  const logger = new Logger({ component: "pair" }, { logDir: paths.logsDir });
  const db = Database.open(paths.databasePath);
  runMigrations(db);
  const repository = new JobRepository(db);
  const pairing = new PairingService({ repository, logger });

  const { token, source } = await resolveToken(config, options);
  const client = new TelegramClient(token, { logger });
  let me;
  try {
    me = await client.getMe();
  } catch (error) {
    const message = (error as Error).message;
    if (/401|Unauthorized/i.test(message)) {
      throw new Error(
        [
          "Telegram rejected this token (401 Unauthorized). Nothing was stored.",
          "Common causes: a typo or missing character, the token was revoked, or the bot was deleted.",
          "Open @BotFather, send /mybots (or /newbot) and copy a fresh token, then run scripts\\pair-window.ps1 again.",
        ].join("\n"),
      );
    }
    throw error;
  }
  console.log(`Bot verified: @${me.username ?? me.first_name} (id ${me.id}). Token source: ${source}; it will be stored with DPAPI.`);
  const webhook = await client.getWebhookInfo();
  if (webhook.url && webhook.url.length > 0) {
    console.log("This bot currently has a webhook configured. Polling and webhooks cannot coexist.");
    if (await confirm("Delete the webhook now and continue with long polling?")) {
      await client.deleteWebhook(false);
      console.log("Webhook deleted.");
    } else {
      console.log("Aborted: remove the webhook explicitly, then re-run pairing.");
      db.close();
      return 3;
    }
  }
  await new DpapiSecretStore(paths.secretsDir).set(config.telegram.tokenSecretName, token).catch((error: Error) => {
    console.log(`Warning: could not persist the token with DPAPI (${error.message}); it is still available through PI_TG_BOT_TOKEN.`);
  });

  const code = generatePairingCode();
  pairing.startPairing(code);
  console.log("");
  console.log("Pairing window open for 10 minutes.");
  console.log(`1) Open the private chat with @${me.username ?? "your bot"}`);
  console.log(`2) Send: /start ${code}`);
  if (me.username) {
    console.log("");
    console.log("One-click alternative (opens the bot and sends the code):");
    console.log(`   https://t.me/${me.username}?start=${code}`);
  }
  console.log("");

  const lockPath = paths.lockPath;
  const lock = readLockInfo(lockPath);
  let controllerRunning = false;
  if (lock) {
    try {
      process.kill(lock.pid, 0);
      controllerRunning = true;
    } catch {
      // Stale lock from an abruptly stopped controller: it is not polling.
      controllerRunning = false;
      try {
        rmSync(lockPath, { force: true });
        console.log("Removed a stale controller lock left by an abrupt stop.");
      } catch {
        /* the controller will clear it on next startup */
      }
    }
  }
  if (!controllerRunning) {
    console.log("Controller is not running; this command will poll Telegram for the pairing code itself.");
  }

  const deadline = Date.now() + PAIRING_CODE_TTL_MS;
  let candidate = pairing.getPendingCandidate();
  let offset: number | undefined = repository.getReceiveCursor() !== undefined ? repository.getReceiveCursor()! + 1 : undefined;
  while (!candidate && Date.now() < deadline) {
    if (!controllerRunning) {
      try {
        const updates = await client.getUpdates(offset, 10, ["message"]);
        if (updates.length > 0) console.log(`Fetched ${updates.length} update(s): ${updates.map((update) => update.update_id).join(", ")}`);
        for (const update of updates) {
          offset = update.update_id + 1;
          repository.setReceiveCursor(update.update_id);
          const message = update.message;
          if (!message || message.chat.type !== "private" || !message.from) continue;
          const parsed = parseCommandText(message.text ?? "");
          if (parsed.type === "start") {
            console.log(`Incoming /start from user ${message.from.id} chat ${message.chat.id}${parsed.code ? " with a code" : " without a code"}.`);
            if (parsed.code) {
              const result = pairing.submitPairingCode(parsed.code, message.from, String(message.chat.id));
              console.log(result.ok ? "Code accepted; candidate recorded." : `Code rejected: ${result.message}`);
            }
          }
        }
      } catch (error) {
        logger.warn("pair.poll_error", "Pairing poll failed; retrying.", { message: (error as Error).message });
      }
    }
    candidate = pairing.getPendingCandidate();
    if (!candidate) await new Promise((resolvePromise) => setTimeout(resolvePromise, 1000));
  }

  if (!candidate) {
    console.log("Timed out without a pairing candidate. Run this command again.");
    pairing.cancelPairing();
    db.close();
    return 4;
  }

  console.log("Pairing candidate:");
  console.log(`  user id : ${candidate.userId}`);
  console.log(`  chat id : ${candidate.chatId}`);
  console.log(`  name    : ${candidate.displayName}`);
  if (!(await confirm("Accept this Telegram account as the sole owner?"))) {
    console.log("Rejected locally. No configuration was changed.");
    pairing.cancelPairing();
    db.close();
    return 0;
  }

  const next = validateConfig({
    ...config,
    telegram: { ...config.telegram, ownerUserId: candidate.userId, ownerChatId: candidate.chatId },
  });
  saveConfigAtomic(options.configPath, next);
  pairing.acceptCandidate();
  try {
    await client.sendMessage(candidate.chatId, ["Paired successfully.", "", "/status - current state", "/help - command reference", "/stop - cancel and suspend dispatch"].join("\n"));
  } catch (error) {
    console.log(`Warning: confirmation message failed (${(error as Error).message.slice(0, 120)}).`);
  }
  console.log(`Owner saved to ${options.configPath}. Restart the controller if it is running, or start it now.`);
  db.close();
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(`Pairing failed: ${(error as Error).message}`);
    process.exitCode = 1;
  });
