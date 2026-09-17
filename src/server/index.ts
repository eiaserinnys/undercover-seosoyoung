import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { createCollector } from "./discordCollector.js";
import { createAppServer } from "./http.js";
import { MessageEventHub } from "./messageEvents.js";
import { resolveRuntimeRootDir, resolveStaticDir } from "./runtimePaths.js";
import { SlackRelayService, SlackWebApiClient } from "./slackRelay.js";
import { SlackRelayStore } from "./slackRelayStore.js";
import { createTranslationService } from "./translation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolveRuntimeRootDir(resolve(__dirname));
const staticDir = resolveStaticDir(rootDir);

const config = loadConfig(rootDir);
const db = new AppDatabase(config.databasePath, config.discordMockMode);
const messageEvents = new MessageEventHub();
let relayStore: SlackRelayStore | null = null;
let relay: SlackRelayService | null = null;
if (
  config.slackRelay.enabled &&
  config.slackRelay.configErrors.length === 0 &&
  config.slackRelay.channelId &&
  config.slackRelay.botUserId &&
  config.slackRelay.botToken
) {
  try {
    relayStore = new SlackRelayStore(config.databasePath);
    relay = new SlackRelayService(relayStore, new SlackWebApiClient(config.slackRelay.botToken), {
      channelId: config.slackRelay.channelId,
      botUserId: config.slackRelay.botUserId
    });
    // Establish the no-send baseline before the collector can accept a new
    // Discord event.
    relay.initialize();
  } catch (error) {
    console.error("Slack relay initialization failed; Discord collection remains active", error);
    relayStore?.close();
    relayStore = null;
    relay = null;
  }
}
if (config.slackRelay.enabled && config.slackRelay.configErrors.length > 0) {
  console.error("Slack relay is disabled by configuration", config.slackRelay.configErrors);
}
const unsubscribeRelay = relay
  ? messageEvents.subscribe((payload) => {
      try {
        relay?.handleMessageChange(payload.message.messageId);
      } catch (error) {
        console.error("Slack relay could not record a message change; Discord collection remains active", {
          messageId: payload.message.messageId,
          error
        });
      }
    })
  : null;
const translation = createTranslationService(config, db, messageEvents);
if (config.translation.configErrors.length > 0) {
  console.error("Translation is disabled by configuration", config.translation.configErrors);
}
const collector = createCollector(config, db, {
  onMessageChange(change) {
    messageEvents.publish(change);
    translation.handleMessageChange(change);
  }
});
const server = createAppServer({ config, db, messageEvents, staticDir });

server.listen(config.port, "127.0.0.1", () => {
  console.log(`undercover-seosoyoung listening on http://127.0.0.1:${config.port} (${collector.mode})`);
});

translation.start();
void collector.start().catch((error) => {
  console.error("Discord collector failed to start", error);
});
void relay?.start().catch((error) => {
  console.error("Slack relay failed to start; Discord collection remains active", error);
});

async function shutdown(): Promise<void> {
  unsubscribeRelay?.();
  await Promise.all([translation.stop(), collector.stop(), relay?.stop()]);
  relayStore?.close();
  db.close();
  server.close();
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
