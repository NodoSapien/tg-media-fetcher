import { bot } from "./bot/bot.js";
import { ensureBaseDir, purgeStale } from "./storage/temp-file.manager.js";

async function main(): Promise<void> {
  await ensureBaseDir();
  await purgeStale();

  const stop = (signal: string) => {
    console.log(`\n[main] ${signal} recibido, deteniendo bot…`);
    void bot.stop();
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));

  console.log("[main] Iniciando bot (long polling)…");
  await bot.start({
    onStart: (info) => console.log(`[main] Bot @${info.username} en línea.`),
  });
}

main().catch((error) => {
  console.error("[main] error fatal:", error);
  process.exit(1);
});
