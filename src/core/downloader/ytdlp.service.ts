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

export interface DownloadOptions {
  /** Directorio (único, idealmente vacío) donde se escribe la descarga. */
  outDir: string;
  /** Permite abortar la descarga (mata el proceso de yt-dlp). */
  signal?: AbortSignal;
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

/**
 * Descarga la mejor calidad disponible de `url` dentro de `outDir`.
 * yt-dlp invoca ffmpeg automáticamente para mergear audio/video separados.
 */
export function download(
  url: string,
  options: DownloadOptions,
): Promise<DownloadResult> {
  const { outDir, signal } = options;

  const args = [
    "-f",
    "bv*+ba/b",
    "--merge-output-format",
    "mp4",
    "--no-playlist",
    "--no-progress",
    "--ffmpeg-location",
    env.FFMPEG_PATH,
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
