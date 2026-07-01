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
    "",
    "📝 Cada archivo llega con su título (enlazado a la URL), duración y plataforma.",
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
// guarda la URL (y la metadata ya sondeada) en memoria y el botón lleva solo un
// token corto que la referencia.
interface Pending {
  url: string;
  metadata?: ytdlp.MediaMetadata;
}
const pending = new Map<string, Pending>();
const MAX_PENDING = 50;

function storePending(url: string, metadata?: ytdlp.MediaMetadata): string {
  const token = randomUUID().slice(0, 8);
  // Cap simple para no crecer sin límite: descarta la entrada más antigua
  // (Map conserva el orden de inserción).
  if (pending.size >= MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest !== undefined) pending.delete(oldest);
  }
  pending.set(token, { url, metadata });
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

/** Sondea metadata sin bloquear el flujo: si falla, devuelve undefined. */
async function safeProbe(url: string): Promise<ytdlp.MediaMetadata | undefined> {
  return ytdlp.probe(url).catch(() => undefined);
}

function htmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Segundos → `H:MM:SS` (o `M:SS` si dura menos de una hora). */
function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${ss}`;
  return `${m}:${ss}`;
}

/** Línea secundaria "⏱ duración · 📺 plataforma" (omite lo que falte). */
function metaLine(metadata?: ytdlp.MediaMetadata): string | undefined {
  if (!metadata) return undefined;
  const parts: string[] = [];
  if (typeof metadata.durationSec === "number") {
    parts.push(`⏱ ${formatDuration(metadata.durationSec)}`);
  }
  if (metadata.platform) parts.push(`📺 ${htmlEscape(metadata.platform)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** Caption HTML: título enlazado a la URL, más duración/plataforma. */
function buildCaption(
  metadata: ytdlp.MediaMetadata | undefined,
  fallbackUrl: string,
): string {
  const url = metadata?.webpageUrl ?? fallbackUrl;
  const title = metadata?.title ?? url;
  const link = `<a href="${htmlEscape(url)}">${htmlEscape(title)}</a>`;
  const line = metaLine(metadata);
  return line ? `${link}\n${line}` : link;
}

/** Encabezado HTML del menú: título/duración/plataforma + "Elige la calidad:". */
function buildMenuHeader(metadata?: ytdlp.MediaMetadata): string {
  const lines: string[] = [];
  if (metadata?.title) lines.push(`<b>${htmlEscape(metadata.title)}</b>`);
  const line = metaLine(metadata);
  if (line) lines.push(line);
  lines.push("Elige la calidad:");
  return lines.join("\n");
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

/** Edita un mensaje con parse_mode HTML y un teclado inline (ignora errores). */
async function safeEditHtml(
  ctx: Context,
  chatId: number,
  messageId: number,
  text: string,
  keyboard: InlineKeyboard,
): Promise<void> {
  try {
    await ctx.api.editMessageText(chatId, messageId, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  } catch {
    /* no-op */
  }
}

async function sendByType(
  ctx: Context,
  chatId: number,
  filePath: string,
  opts: { asDocument?: boolean; caption?: string } = {},
): Promise<void> {
  const file = new InputFile(filePath);
  const extra = opts.caption
    ? { caption: opts.caption, parse_mode: "HTML" as const }
    : {};

  // Entrega "sin compresión": el archivo original tal cual, sin que Telegram
  // lo re-codifique a un video reproducible.
  if (opts.asDocument) {
    await ctx.api.sendDocument(chatId, file, extra);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  if (VIDEO_EXTS.has(ext)) {
    await ctx.api.sendVideo(chatId, file, { supports_streaming: true, ...extra });
  } else if (AUDIO_EXTS.has(ext)) {
    await ctx.api.sendAudio(chatId, file, extra);
  } else if (IMAGE_EXTS.has(ext)) {
    await ctx.api.sendPhoto(chatId, file, extra);
  } else {
    await ctx.api.sendDocument(chatId, file, extra);
  }
}

function runJob(
  ctx: Context,
  chatId: number,
  statusMsgId: number,
  url: string,
  choice: Choice,
  metadata?: ytdlp.MediaMetadata,
) {
  return async (): Promise<void> => {
    const jobDir = await tempFiles.createJobDir();
    try {
      // Si no llega metadata (camino sin menú), la sondeamos ahora (best-effort)
      // para no bloquear el encolado.
      let meta = metadata;
      if (meta === undefined) {
        await safeEdit(ctx, chatId, statusMsgId, "🔎 Analizando…");
        meta = await safeProbe(url);
      }

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
      await sendByType(ctx, chatId, filePath, {
        asDocument: choice.asDocument,
        caption: buildCaption(meta, url),
      });

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

    // Menú opcional ("mensaje extra"): si está activo, sondeamos la metadata,
    // la mostramos y preguntamos la calidad antes de descargar; si no, bajamos
    // la mejor calidad directamente.
    if (env.QUALITY_MENU) {
      const analyzing = await ctx.reply("🔎 Analizando enlace…");
      const metadata = await safeProbe(url);
      const token = storePending(url, metadata);
      await safeEditHtml(
        ctx,
        ctx.chat.id,
        analyzing.message_id,
        buildMenuHeader(metadata),
        buildMenu(token),
      );
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
    const entry = pending.get(token!);

    if (!choice || !entry) {
      await ctx.answerCallbackQuery({
        text: "Esa selección expiró, reenvía la URL.",
      });
      return;
    }

    pending.delete(token!);
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
    queue.add(runJob(ctx, chatId, msgId, entry.url, choice, entry.metadata));
  });
}
