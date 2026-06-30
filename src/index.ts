#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { startBot } from "./bot.js";

async function main() {
  const config = loadConfig();
  await startBot(config);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
