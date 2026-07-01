import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env.js";

export class YtDlpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YtDlpError";
  }
}

/** El binario de yt-dlp no se encontró en el PATH / ruta configurada. */
export class YtDlpNotFoundError extends YtDlpError {
  constructor() {
    super(
      `No se encontró yt-dlp en "${env.YTDLP_PATH}". Instálalo o ajusta YTDLP_PATH.`,
    );
    this.name = "YtDlpNotFoundError";
  }
}

/** El disco / tmpfs se quedó sin espacio. */
export class DiskFullError extends YtDlpError {
  constructor() {
    super("No queda espacio en disco para la descarga.");
    this.name = "DiskFullError";
  }
}

/** La URL no es soportada por yt-dlp o no es válida. */
export class UnsupportedUrlError extends YtDlpError {
  constructor() {
    super("URL no soportada o inválida para descargar.");
    this.name = "UnsupportedUrlError";
  }
}

/** Perfil de calidad/formato solicitado. Determina los args `-f` de yt-dlp. */
export type FormatProfile = "best" | "1080p" | "720p" | "480p" | "audio";

export interface DownloadOptions {
  /** Directorio (único, idealmente vacío) donde se escribe la descarga. */
  outDir: string;
  /** Permite abortar la descarga (mata el proceso de yt-dlp). */
  signal?: AbortSignal;
  /** Calidad/formato a descargar. Por defecto, la mejor disponible. */
  profile?: FormatProfile;
}

export interface DownloadResult {
  filePath: string;
}

const PARTIAL_SUFFIXES = [".part", ".ytdl", ".temp", ".tmp"];

function classifyStderr(stderr: string): YtDlpError | undefined {
  const lower = stderr.toLowerCase();
  if (lower.includes("no space left") || lower.includes("enospc")) {
    return new DiskFullError();
  }
  if (
    lower.includes("unsupported url") ||
    lower.includes("is not a valid url")
  ) {
    return new UnsupportedUrlError();
  }
  return undefined;
}

/** Localiza el único archivo media producido en outDir (ignora parciales). */
async function findDownloadedFile(outDir: string): Promise<string | undefined> {
  const entries = await fs.readdir(outDir, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter(
      (name) => !PARTIAL_SUFFIXES.some((suffix) => name.endsWith(suffix)),
    );

  if (candidates.length === 0) return undefined;
  const first = candidates[0]!;
  return path.join(outDir, first);
}

/** Traduce un perfil a los args de selección/salida de yt-dlp. */
function formatArgs(profile: FormatProfile): string[] {
  if (profile === "audio") {
    // Extrae solo la pista de audio y la transcodifica a MP3 (vía ffmpeg).
    // Sin --merge-output-format: la salida es .mp3, no un contenedor mp4.
    return ["-f", "ba/b", "-x", "--audio-format", "mp3", "--audio-quality", "0"];
  }
  const heightCap: Record<"1080p" | "720p" | "480p", number> = {
    "1080p": 1080,
    "720p": 720,
    "480p": 480,
  };
  const selector =
    profile === "best"
      ? "bv*+ba/b"
      : `bv*[height<=${heightCap[profile]}]+ba/b[height<=${heightCap[profile]}]`;
  return ["-f", selector, "--merge-output-format", "mp4"];
}

/**
 * Descarga `url` dentro de `outDir` según el perfil pedido (por defecto, la
 * mejor calidad). yt-dlp invoca ffmpeg automáticamente para mergear audio/video
 * separados o para extraer el audio.
 */
export function download(
  url: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const { outDir, signal, profile = "best" } = options;

  // Solo pasar --ffmpeg-location si FFMPEG_PATH es una ruta real. yt-dlp trata
  // ese parámetro como una ubicación del filesystem, no busca en el PATH; si le
  // pasamos un nombre suelto (p. ej. "ffmpeg") no lo encuentra y omite el merge.
  // Cuando es solo un nombre, dejamos que yt-dlp lo resuelva por el PATH.
  const ffmpegIsPath =
    path.isAbsolute(env.FFMPEG_PATH) ||
    env.FFMPEG_PATH.includes("/") ||
    env.FFMPEG_PATH.includes("\\");

  const args = [
    ...formatArgs(profile),
    "--no-playlist",
    "--no-progress",
    ...(ffmpegIsPath ? ["--ffmpeg-location", env.FFMPEG_PATH] : []),
    "-o",
    path.join(outDir, "%(id)s.%(ext)s"),
    url,
  ];

  return new Promise<DownloadResult>((resolve, reject) => {
    const child = spawn(env.YTDLP_PATH, args, { signal });

    let stderr = "";
    const STDERR_CAP = 16_384;
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) {
        stderr += chunk.toString();
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        reject(new YtDlpNotFoundError());
      } else if (error.name === "AbortError") {
        reject(error);
      } else {
        reject(new YtDlpError(error.message));
      }
    });

    child.on("close", (code) => {
      if (signal?.aborted) {
        reject(new YtDlpError("Descarga cancelada."));
        return;
      }
      if (code !== 0) {
        const classified = classifyStderr(stderr);
        const tail = stderr.trim().split("\n").slice(-3).join("\n");
        reject(
          classified ??
            new YtDlpError(
              `yt-dlp salió con código ${code}${tail ? `:\n${tail}` : "."}`,
            ),
        );
        return;
      }

      findDownloadedFile(outDir)
        .then((filePath) => {
          if (!filePath) {
            reject(
              new YtDlpError(
                "yt-dlp terminó sin producir un archivo de salida.",
              ),
            );
            return;
          }
          resolve({ filePath });
        })
        .catch((error: unknown) =>
          reject(
            error instanceof Error
              ? new YtDlpError(error.message)
              : new YtDlpError(String(error)),
          ),
        );
    });
  });
}
