import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";

const BASE_DIR = env.DOWNLOAD_TMP_DIR;

/** Crea el directorio base de descargas si no existe. Llamar al arrancar. */
export async function ensureBaseDir(): Promise<void> {
  await fs.mkdir(BASE_DIR, { recursive: true });
}

/** Crea un subdirectorio único para un job y devuelve su ruta absoluta. */
export async function createJobDir(): Promise<string> {
  const dir = path.join(BASE_DIR, randomUUID());
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Elimina recursivamente un directorio de job (idempotente). */
export async function cleanup(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (error) {
    console.error(`[temp] no se pudo limpiar ${dir}:`, error);
  }
}

/** Elimina restos de jobs de ejecuciones previas (recuperación tras crash). */
export async function purgeStale(): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(BASE_DIR);
  } catch {
    return; // el dir base aún no existe; nada que purgar
  }
  await Promise.all(
    entries.map((entry) => cleanup(path.join(BASE_DIR, entry))),
  );
}
