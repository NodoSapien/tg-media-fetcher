import type { Context, NextFunction } from "grammy";
import { env } from "../../config/env.js";

/**
 * Permite continuar sólo si el remitente coincide con ALLOWED_USER_ID.
 * Cualquier otro usuario se ignora en silencio: sin respuesta y sin loguear
 * datos del remitente.
 */
export async function authMiddleware(
  ctx: Context,
  next: NextFunction,
): Promise<void> {
  if (ctx.from?.id !== env.ALLOWED_USER_ID) {
    return;
  }
  await next();
}
