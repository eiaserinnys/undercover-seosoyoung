import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { AppDatabase } from "./database.js";
import { createCollector } from "./discordCollector.js";
import { createAppServer } from "./http.js";
import { MessageEventHub } from "./messageEvents.js";
import { resolveRuntimeRootDir, resolveStaticDir } from "./runtimePaths.js";
import { createTranslationService } from "./translation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = resolveRuntimeRootDir(resolve(__dirname));
const staticDir = resolveStaticDir(rootDir);

const config = loadConfig(rootDir);
const db = new AppDatabase(config.databasePath, config.discordMockMode);
const messageEvents = new MessageEventHub();
const translation = createTranslationService(config, db, messageEvents);
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

collector.start().catch((error) => {
  console.error("Discord collector failed to start", error);
});
translation.start();

async function shutdown(): Promise<void> {
  translation.stop();
  await collector.stop();
  db.close();
  server.close();
}

process.on("SIGINT", () => {
  shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  shutdown().finally(() => process.exit(0));
});
