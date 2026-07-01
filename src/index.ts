import { bot } from "./bot/bot.js";
import { queue } from "./bot/handlers/download.handler.js";
import { ensureBaseDir, purgeStale } from "./storage/temp-file.manager.js";

async function main(): Promise<void> {
  await ensureBaseDir();
  await purgeStale();

  const stop = async (signal: string): Promise<void> => {
    console.log(`\n[main] ${signal} recibido, deteniendo polling…`);
    await bot.stop();
    if (!queue.isIdle) {
      console.log("[main] esperando a que termine el job en curso…");
      await queue.waitUntilIdle();
    }
    console.log("[main] apagado completo.");
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));

  // Registra el menú "/" nativo de Telegram con la lista de comandos.
  await bot.api.setMyCommands([
    { command: "start", description: "Bienvenida y lista de comandos" },
    { command: "help", description: "Bienvenida y lista de comandos" },
    { command: "audio_only", description: "Descargar solo el audio (MP3)" },
    { command: "sd", description: "Video en calidad reducida (480p)" },
    { command: "file", description: "Archivo original sin compresión" },
  ]);

  console.log("[main] Iniciando bot (long polling)…");
  await bot.start({
    onStart: (info) => console.log(`[main] Bot @${info.username} en línea.`),
  });
}

main().catch((error) => {
  console.error("[main] error fatal:", error);
  process.exit(1);
});
