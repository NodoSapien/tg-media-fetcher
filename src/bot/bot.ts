import { Bot, GrammyError, HttpError } from "grammy";
import { env } from "../config/env.js";
import { registerDownloadHandler } from "./handlers/download.handler.js";
import { authMiddleware } from "./middlewares/auth.middleware.js";

export const bot = new Bot(env.BOT_TOKEN, {
  client: { apiRoot: env.TELEGRAM_API_BASE_URL },
});

// 1) Acceso restringido (descarta usuarios no autorizados antes de cualquier handler).
bot.use(authMiddleware);

// 2) Comandos + handler de descargas.
registerDownloadHandler(bot);

// 3) Frontera global de errores: nunca debe tumbar el proceso.
bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[bot] error en update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("  GrammyError:", e.description);
  } else if (e instanceof HttpError) {
    console.error("  HttpError:", e);
  } else {
    console.error("  ", e);
  }
});
