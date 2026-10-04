import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppConfig } from "../../src/config.js";

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const root = join(tmpdir(), "alfred-tests", randomUUID());
  const base: AppConfig = {
    schemaVersion: 1,
    dryRun: true,
    dataRoot: root,
    workRoot: join(root, "work"),
    timeZone: "UTC",
    telegram: {
      tokenSecretName: "alfred/bot-token",
      ownerUserId: "1001",
      ownerChatId: "1001",
      pollTimeoutSeconds: 25,
      allowedUpdates: ["message", "callback_query"],
    },
    models: {
      authPath: join(root, "auth.json"),
      baseModelsPath: join(root, "models.json"),
      catalogSeedPath: join(root, "models-store.json"),
      selectedSlot: "openrouter",
      thinking: "medium",
      allowAutomaticModelFallback: false,
      slots: {
        deepseek: { provider: "deepseek", modelId: "deepseek-flash" },
        openrouter: { provider: "openrouter", modelId: "stealth/space-bunny-alpha", routing: { only: ["stealth"], allow_fallbacks: false }, requireZeroTokenPrice: true },
      },
    },
    desktop: {
      requireUnlockedSession: true,
      observationMaxAgeMs: 60000,
      nativeToolTimeoutMs: 20000,
      pauseOnObservedHumanInput: true,
      localStopHotkey: "Ctrl+Alt+F12",
    },
    browser: {
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      profileDir: join(root, "browser", "profile"),
      outputDir: join(root, "browser", "output"),
      headed: true,
      showActions: true,
    },
    jobs: {
      maxQueued: 5,
      maxRunSeconds: 1800,
      maxToolCalls: 150,
      maxModelTurns: 60,
      maxConsecutiveNoProgress: 3,
      autoStartMaxAgeSeconds: 600,
      stopGraceMs: 3000,
    },
    artifacts: { retentionDays: 7, maxTotalMiB: 1024, inboundMaxMiB: 10, photoTargetMiB: 4, sendExactPngOnRequest: true },
    notifications: { progressMinimumIntervalSeconds: 15, automaticStepScreenshots: false, completionScreenshot: "when-useful" },
  };
  return { ...base, ...overrides };
}
