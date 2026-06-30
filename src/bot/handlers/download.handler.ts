import fs from "node:fs/promises";
import path from "node:path";
import { type Bot, type Context, InputFile } from "grammy";
import * as ytdlp from "../../core/downloader/ytdlp.service.js";
import { YtDlpError } from "../../core/downloader/ytdlp.service.js";
import { DownloadQueue } from "../../core/queue/download-queue.js";
import * as tempFiles from "../../storage/temp-file.manager.js";

const queue = new DownloadQueue();

// Límite del Local Bot API Server (~2 GB).
const MAX_UPLOAD_BYTES = 2000 * 1024 * 1024;

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v"]);

const HELP_TEXT =
  "Envíame una URL (YouTube, Twitter/X, Instagram, etc.) y te devuelvo el media en su mejor calidad.";

function extractUrl(text: string): string | undefined {
  return URL_REGEX.exec(text)?.[1];
}

/** Edita el mensaje de estado ignorando errores (p. ej. mensaje sin cambios). */
async function safeEdit(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, text);
  } catch {
    /* no-op */
  }
}

async function sendByType(
  ctx: Context,
  chatId: number,
  filePath: string,
): Promise<void> {
  const ext = path.extname(filePath).toLowerCase();
  const file = new InputFile(filePath);

  if (VIDEO_EXTS.has(ext)) {
    await ctx.api.sendVideo(chatId, file, { supports_streaming: true });
  } else if (AUDIO_EXTS.has(ext)) {
    await ctx.api.sendAudio(chatId, file);
  } else if (IMAGE_EXTS.has(ext)) {
    await ctx.api.sendPhoto(chatId, file);
  } else {
    await ctx.api.sendDocument(chatId, file);
  }
}

function runJob(ctx: Context, chatId: number, statusMsgId: number, url: string) {
  return async (): Promise<void> => {
    const jobDir = await tempFiles.createJobDir();
    try {
      await safeEdit(ctx, chatId, statusMsgId, "⬇️ Descargando…");
      const { filePath } = await ytdlp.download(url, { outDir: jobDir });

      const { size } = await fs.stat(filePath);
      if (size > MAX_UPLOAD_BYTES) {
        await safeEdit(
          ctx,
          chatId,
          statusMsgId,
          "❌ El archivo supera el límite de 2 GB y no se puede enviar.",
        );
        return;
      }

      await safeEdit(ctx, chatId, statusMsgId, "📤 Subiendo…");
      await sendByType(ctx, chatId, filePath);

      await safeEdit(ctx, chatId, statusMsgId, "✅ Listo");
    } catch (error) {
      const message =
        error instanceof YtDlpError
          ? `❌ ${error.message}`
          : "❌ Ocurrió un error procesando la descarga.";
      if (!(error instanceof YtDlpError)) {
        console.error("[download] error inesperado:", error);
      }
      await safeEdit(ctx, chatId, statusMsgId, message);
    } finally {
      await tempFiles.cleanup(jobDir);
    }
  };
}

export function registerDownloadHandler(bot: Bot): void {
  bot.command("start", (ctx) => ctx.reply(`👋 ¡Hola! ${HELP_TEXT}`));
  bot.command("help", (ctx) => ctx.reply(HELP_TEXT));

  bot.on("message:text", async (ctx) => {
    const url = extractUrl(ctx.message.text);
    if (!url) {
      await ctx.reply(HELP_TEXT);
      return;
    }

    const position = queue.pending;
    const status = await ctx.reply(
      position > 0 ? `⏳ En cola (posición ${position + 1})…` : "⏳ En cola…",
    );

    queue.add(runJob(ctx, ctx.chat.id, status.message_id, url));
  });
}
