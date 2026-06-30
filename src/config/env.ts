import os from "node:os";
import path from "node:path";
import "dotenv/config";
import { z } from "zod";

const defaultTmpDir = path.join(os.tmpdir(), "tg-media-fetcher");

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1, "BOT_TOKEN es obligatorio"),
  ALLOWED_USER_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_ID: z.string().min(1, "TELEGRAM_API_ID es obligatorio"),
  TELEGRAM_API_HASH: z.string().min(1, "TELEGRAM_API_HASH es obligatorio"),
  TELEGRAM_API_BASE_URL: z.string().url().default("http://127.0.0.1:8081"),
  DOWNLOAD_TMP_DIR: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) => value ?? defaultTmpDir),
  YTDLP_PATH: z.string().min(1).default("yt-dlp"),
  FFMPEG_PATH: z.string().min(1).default("ffmpeg"),
});

// Trata variables vacías ("FOO=") como ausentes: así los campos opcionales o
// con default no fallan la validación cuando el .env las deja en blanco
// (p. ej. DOWNLOAD_TMP_DIR=), y los obligatorios reportan "Required" claro.
const rawEnv = Object.fromEntries(
  Object.entries(process.env).map(([key, value]) => [
    key,
    typeof value === "string" && value.trim() === "" ? undefined : value,
  ]),
);

const parsed = envSchema.safeParse(rawEnv);

if (!parsed.success) {
  console.error("❌ Variables de entorno inválidas:");
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

export type Env = z.infer<typeof envSchema>;

export const env: Readonly<Env> = Object.freeze(parsed.data);
