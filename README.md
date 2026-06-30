# tg-media-fetcher

Bot de Telegram de uso **personal y privado** que actúa como wrapper local de `yt-dlp`,
descargando contenido multimedia desde múltiples plataformas (YouTube, Twitter/X,
Instagram, etc.) en su máxima calidad disponible y enviándolo directamente vía Telegram,
usando un **Local Bot API Server** para soportar archivos de hasta 2 GB.

> ⚠️ Este repositorio es para uso personal. El acceso está restringido por `user_id` a
> nivel de aplicación.

> 📲 ¿Primera vez configurando el bot? Ve directo a la
> [Guía de usuario final](GUIA_USUARIO.md) — instrucciones paso a paso desde cero.

---

## 🏗️ Arquitectura

```
Usuario → Telegram → [Bot Node.js/grammY] → auth middleware (ALLOWED_USER_ID)
                                           → download-queue (FIFO secuencial)
                                           → ytdlp.service (spawn yt-dlp + ffmpeg merge)
                                           → DOWNLOAD_TMP_DIR (archivo efímero)
                                           → Local Bot API Server (upload por streaming)
                                           → Telegram API
                                           → temp-file.manager.cleanup()
```

**Decisiones de diseño clave:**

| Decisión | Razón |
|---|---|
| Node.js + TypeScript + grammY | Manejo maduro de `child_process` y streams; grammY es el framework de bots TS más sólido, con middlewares nativos |
| Cola secuencial (sin concurrencia) | Uso de un solo usuario; evita saturar disco/red y simplifica el manejo de errores |
| Long polling (no webhook) | Sin necesidad de exponer HTTPS público; el bot corre en máquina local |
| Local Bot API Server (Docker) | El API público de Telegram limita archivos a 50 MB; el server self-hosted sube el límite a 2 GB |
| Upload por **streaming** (`InputFile`) | El bot lee el archivo de su propio `DOWNLOAD_TMP_DIR` y lo envía por loopback al server local. No requiere volumen compartido ni modo `--local`. Multiplataforma (Windows/Linux) |
| ffmpeg sin orquestación propia | yt-dlp lo invoca automáticamente para el merge de pistas de audio/video separadas (1080p+) |

> **Nota:** una alternativa más optimizada (zero-copy) es correr el server en modo
> `--local` y pasarle la ruta del archivo en un volumen compartido. Este proyecto usa
> **streaming** por simplicidad y portabilidad; sigue soportando 2 GB.

---

## 📋 Requisitos previos

1. **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** instalado y en el `PATH`. Mantener actualizado: `yt-dlp -U`.
2. **[FFmpeg](https://ffmpeg.org/)** instalado y en el `PATH`.
3. **Node.js v18+** (gestor recomendado: pnpm; npm/yarn también funcionan).
4. **Docker + Docker Compose** (para el Local Bot API Server; Docker Desktop en Windows).
5. **Token de bot** — vía [@BotFather](https://t.me/BotFather).
6. **`api_id` y `api_hash`** — vía [my.telegram.org](https://my.telegram.org) (requeridos por el server local).
7. **Tu `user_id`** — vía [@userinfobot](https://t.me/userinfobot).

---

## 🗂️ Estructura del proyecto

```
tg-media-fetcher/
├── docker-compose.yml
├── .env.example
├── package.json
├── tsconfig.json
├── README.md
├── GUIA_USUARIO.md                # guía paso a paso para el usuario final
└── src/
    ├── index.ts                       # entry point, arranca el bot
    ├── config/
    │   └── env.ts                     # validación de variables de entorno (zod)
    ├── bot/
    │   ├── bot.ts                     # instancia grammY (apiRoot → server local)
    │   ├── middlewares/
    │   │   └── auth.middleware.ts     # valida ALLOWED_USER_ID, ignora en silencio
    │   └── handlers/
    │       └── download.handler.ts    # recibe URL, encola el job, responde estado
    ├── core/
    │   ├── downloader/
    │   │   └── ytdlp.service.ts       # wrapper sobre yt-dlp (spawn + manejo de errores)
    │   └── queue/
    │       └── download-queue.ts      # cola FIFO secuencial in-memory
    └── storage/
        └── temp-file.manager.ts       # ciclo de vida del archivo temporal
```

---

## 🔧 Variables de entorno

Copiar `.env.example` a `.env` y completar. Ver el archivo para la lista completa.
`DOWNLOAD_TMP_DIR` es opcional: si se omite, se usa `<os.tmpdir()>/tg-media-fetcher`.

### (Opcional, solo Linux) tmpfs / RAM disk

Para evitar desgaste del SSD puedes apuntar `DOWNLOAD_TMP_DIR` a un `tmpfs`:

```bash
sudo mkdir -p /mnt/ramdisk-downloads
# /etc/fstab:
# tmpfs  /mnt/ramdisk-downloads  tmpfs  rw,size=4G,uid=1000,gid=1000,mode=0755  0  0
sudo mount -a
```

Esto es una optimización de hardware, no un requisito.

---

## 🐳 Local Bot API Server

```bash
docker compose up -d
```

El server escucha solo en `127.0.0.1:8081`. El bot de Node.js corre en el host (no
requiere Docker) y apunta su cliente grammY a `TELEGRAM_API_BASE_URL`.

---

## 🚀 Uso

```bash
pnpm install
cp .env.example .env   # y completar credenciales
pnpm dev               # desarrollo (tsx watch)
# o
pnpm build && pnpm start
```

Envía una URL al bot desde la cuenta autorizada y responderá con el estado:
`⏳ en cola → ⬇️ descargando → 📤 subiendo → ✅ listo`.

> Para el paso a paso completo (conseguir credenciales, troubleshooting, etc.) ver la
> [Guía de usuario final](GUIA_USUARIO.md).

---

## 🔒 Seguridad y privacidad

- **Acceso restringido:** el middleware valida `user_id` contra `ALLOWED_USER_ID`.
  Cualquier ID no autorizado se ignora en silencio.
- **Almacenamiento efímero:** cada job descarga a un subdirectorio único en
  `DOWNLOAD_TMP_DIR` que se elimina en un `finally` (éxito o fallo). Al arrancar se
  purgan restos de ejecuciones previas.
- **Sin exposición de puertos:** el server local escucha solo en `127.0.0.1`; el bot usa
  long polling (sin puertos entrantes).
- **Manejo de errores:** URL inválida/no soportada, disco lleno (`ENOSPC`), archivo
  > 2 GB y fallos de red se manejan con gracia (se notifica al usuario, se limpia, no se
  crashea el proceso).

---

## 📚 Referencias

- [yt-dlp](https://github.com/yt-dlp/yt-dlp)
- [grammY](https://grammy.dev/)
- [Telegram Bot API — Local Server](https://github.com/tdlib/telegram-bot-api)
- [aiogram/telegram-bot-api (Docker)](https://github.com/aiogram/telegram-bot-api)
- [FFmpeg](https://ffmpeg.org/)
