import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { type Bot, type Context, InlineKeyboard, InputFile } from "grammy";
import { env } from "../../config/env.js";
import * as ytdlp from "../../core/downloader/ytdlp.service.js";
import { YtDlpError } from "../../core/downloader/ytdlp.service.js";
import { DownloadQueue } from "../../core/queue/download-queue.js";
import * as tempFiles from "../../storage/temp-file.manager.js";

export const queue = new DownloadQueue();

// Límite del Local Bot API Server (~2 GB).
const MAX_UPLOAD_BYTES = 2000 * 1024 * 1024;

const URL_REGEX = /(https?:\/\/[^\s]+)/i;

const AUDIO_EXTS = new Set([".mp3", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".flac"]);
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".m4v", ".mkv", ".webm"]);

/** Qué descargar (perfil de calidad) y cómo entregarlo (documento o no). */
interface Choice {
  profile: ytdlp.FormatProfile;
  /** true = enviar como documento original, sin recompresión de Telegram. */
  asDocument: boolean;
}

// Opciones del menú inline. Las claves viajan en el callback_data; el orden de
// inserción define el orden de los botones.
const MENU_CHOICES: Record<string, Choice & { label: string }> = {
  best: { profile: "best", asDocument: false, label: "Best" },
  "1080p": { profile: "1080p", asDocument: false, label: "1080p" },
  "720p": { profile: "720p", asDocument: false, label: "720p" },
  "480p": { profile: "480p", asDocument: false, label: "480p" },
  audio: { profile: "audio", asDocument: false, label: "🎵 Audio" },
  original: { profile: "best", asDocument: true, label: "📁 Original" },
};

const HELP_TEXT =
  "Envíame una URL (YouTube, Twitter/X, Instagram, etc.) y te devuelvo el media. " +
  "Usa /help para ver todas las opciones.";

/** Texto de bienvenida/ayuda; incluye la nota del menú solo si está activo. */
function buildStartText(): string {
  const lines = [
    "👋 tg-media-fetcher",
    "",
    "Soy tu wrapper personal de yt-dlp. Envíame el enlace de un video " +
      "(YouTube, Twitter/X, Instagram, TikTok…) y te lo devuelvo aquí en su " +
      "mejor calidad, hasta 2 GB.",
    "",
    "Cómo usar:",
    "• Pega una URL y la descargo en la mejor calidad.",
    "• /audio_only <URL> — solo el audio (MP3).",
    "• /sd <URL> — video en calidad reducida (480p, pesa menos).",
    "• /file <URL> — archivo original sin compresión (se envía como documento).",
    "• /help — muestra esta ayuda.",
  ];
  if (env.QUALITY_MENU) {
    lines.push(
      "",
      "Al pegar una URL te muestro un menú para elegir la calidad " +
        "(Best / 1080p / 720p / 480p / 🎵 Audio / 📁 Original) antes de descargar.",
    );
  }
  lines.push("", "🔒 Uso privado: solo respondo a la cuenta autorizada.");
  return lines.join("\n");
}

function extractUrl(text: string): string | undefined {
  return URL_REGEX.exec(text)?.[1];
}

// El callback_data de Telegram tiene un tope de 64 bytes: no cabe una URL. Se
// guarda la URL en memoria y el botón lleva solo un token corto que la referencia.
const pendingUrls = new Map<string, string>();
const MAX_PENDING = 50;

function storeUrl(url: string): string {
  const token = randomUUID().slice(0, 8);
  // Cap simple para no crecer sin límite: descarta la entrada más antigua
  // (Map conserva el orden de inserción).
  if (pendingUrls.size >= MAX_PENDING) {
    const oldest = pendingUrls.keys().next().value;
    if (oldest !== undefined) pendingUrls.delete(oldest);
  }
  pendingUrls.set(token, url);
  return token;
}

function buildMenu(token: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  Object.entries(MENU_CHOICES).forEach(([key, choice], index) => {
    kb.text(choice.label, `dl:${key}:${token}`);
    if ((index + 1) % 3 === 0) kb.row();
  });
  return kb;
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
  opts: { asDocument?: boolean } = {},
): Promise<void> {
  const file = new InputFile(filePath);

  // Entrega "sin compresión": el archivo original tal cual, sin que Telegram
  // lo re-codifique a un video reproducible.
  if (opts.asDocument) {
    await ctx.api.sendDocument(chatId, file);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
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

function runJob(
  ctx: Context,
  chatId: number,
  statusMsgId: number,
  url: string,
  choice: Choice,
) {
  return async (): Promise<void> => {
    const jobDir = await tempFiles.createJobDir();
    try {
      await safeEdit(ctx, chatId, statusMsgId, "⬇️ Descargando…");
      const { filePath } = await ytdlp.download(url, {
        outDir: jobDir,
        profile: choice.profile,
      });

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

      await safeEdit(
        ctx,
        chatId,
        statusMsgId,
        choice.asDocument ? "📤 Subiendo (original)…" : "📤 Subiendo…",
      );
      await sendByType(ctx, chatId, filePath, { asDocument: choice.asDocument });

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

/** Crea el mensaje de estado y encola el job. Reusado por texto y comandos. */
async function enqueue(ctx: Context, url: string, choice: Choice): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;

  const position = queue.pending;
  const status = await ctx.reply(
    position > 0 ? `⏳ En cola (posición ${position + 1})…` : "⏳ En cola…",
  );

  queue.add(runJob(ctx, chatId, status.message_id, url, choice));
}

/** Maneja un comando-atajo (`/audio_only`, `/sd`, `/file`) con perfil fijo. */
async function handleCommand(
  ctx: Context,
  choice: Choice,
  usage: string,
): Promise<void> {
  const arg = typeof ctx.match === "string" ? ctx.match : "";
  const url = extractUrl(arg);
  if (!url) {
    await ctx.reply(`Uso: ${usage} <URL>`);
    return;
  }
  await enqueue(ctx, url, choice);
}

export function registerDownloadHandler(bot: Bot): void {
  // Onboarding + ayuda.
  bot.command("start", (ctx) => ctx.reply(buildStartText()));
  bot.command("help", (ctx) => ctx.reply(buildStartText()));

  // Comandos-atajo: van directo a su perfil, sin pasar por el menú (esté
  // activo o no). Deben registrarse antes del handler de texto para que
  // detengan la propagación del update.
  bot.command("audio_only", (ctx) =>
    handleCommand(ctx, { profile: "audio", asDocument: false }, "/audio_only"),
  );
  bot.command("sd", (ctx) =>
    handleCommand(ctx, { profile: "480p", asDocument: false }, "/sd"),
  );
  bot.command("file", (ctx) =>
    handleCommand(ctx, { profile: "best", asDocument: true }, "/file"),
  );

  bot.on("message:text", async (ctx) => {
    const url = extractUrl(ctx.message.text);
    if (!url) {
      await ctx.reply(HELP_TEXT);
      return;
    }

    // Menú opcional ("mensaje extra"): si está activo, preguntamos la calidad
    // antes de descargar; si no, bajamos la mejor calidad directamente.
    if (env.QUALITY_MENU) {
      const token = storeUrl(url);
      await ctx.reply("Elige la calidad:", { reply_markup: buildMenu(token) });
      return;
    }

    await enqueue(ctx, url, MENU_CHOICES.best!);
  });

  bot.on("callback_query:data", async (ctx) => {
    const parsed = /^dl:([^:]+):(.+)$/.exec(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery();
      return;
    }
    const [, choiceKey, token] = parsed;
    const choice = MENU_CHOICES[choiceKey!];
    const url = pendingUrls.get(token!);

    if (!choice || !url) {
      await ctx.answerCallbackQuery({
        text: "Esa selección expiró, reenvía la URL.",
      });
      return;
    }

    pendingUrls.delete(token!);
    await ctx.answerCallbackQuery({ text: choice.label });

    // Reutiliza el propio mensaje del menú como mensaje de estado y quita los
    // botones (inline_keyboard vacío) para que no queden opciones obsoletas.
    const chatId = ctx.chat?.id;
    const msgId = ctx.callbackQuery.message?.message_id;
    if (chatId === undefined || msgId === undefined) return;

    try {
      await ctx.api.editMessageText(
        chatId,
        msgId,
        `⏳ En cola (${choice.label})…`,
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch {
      /* no-op */
    }
    queue.add(runJob(ctx, chatId, msgId, url, choice));
  });
}
