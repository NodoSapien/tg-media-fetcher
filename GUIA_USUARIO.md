# 📲 Guía de usuario final — tg-media-fetcher

Esta guía te lleva paso a paso desde cero hasta tener el bot funcionando y
descargando tu primer video.

---

## 1. Prerequisitos

Instala esto **antes** de tocar el proyecto:

| Herramienta | Cómo verificar | Cómo instalar |
|---|---|---|
| **Node.js v18+** | `node --version` | https://nodejs.org |
| **pnpm** | `pnpm --version` | `corepack enable` (viene con Node 18+) o `npm i -g pnpm` |
| **yt-dlp** | `yt-dlp --version` | `pip install -U yt-dlp` (recomendado, fácil de mantener) o ver https://github.com/yt-dlp/yt-dlp#installation |
| **ffmpeg** | `ffmpeg -version` | Windows: `winget install ffmpeg` o descarga desde https://ffmpeg.org/download.html y agrega la carpeta `bin` al PATH. Linux: `sudo apt install ffmpeg` (Debian/Ubuntu) |
| **Docker + Docker Compose** | `docker --version` y `docker compose version` | https://www.docker.com/products/docker-desktop |

> 💡 Mantén `yt-dlp` actualizado con `yt-dlp -U` cada cierto tiempo — los sitios
> cambian seguido y las versiones viejas dejan de funcionar.

---

## 2. Consigue tus credenciales de Telegram

Necesitas **4 datos**. Tómate 5 minutos, son gratis e inmediatos:

1. **`BOT_TOKEN`** — habla con [@BotFather](https://t.me/BotFather) en Telegram,
   envía `/newbot`, sigue las instrucciones y copia el token que te da
   (forma: `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`).
2. **`ALLOWED_USER_ID`** — habla con [@userinfobot](https://t.me/userinfobot),
   te responde con tu ID numérico (ej. `987654321`). Este es el **único**
   usuario que el bot va a atender.
3. **`TELEGRAM_API_ID`** y **`TELEGRAM_API_HASH`** — entra a
   https://my.telegram.org con tu número de teléfono, ve a
   **API development tools**, crea una app (cualquier nombre sirve) y copia
   ambos valores. Esto lo pide el *Local Bot API Server*, aunque el bot no use
   la API de cliente directamente.

Guarda estos 4 valores en un lugar seguro, los vas a pegar en el `.env` en el
siguiente paso.

---

## 3. Clona y configura el proyecto

```bash
git clone https://github.com/NodoSapien/tg-media-fetcher
cd tg-media-fetcher
pnpm install
```

Copia la plantilla de entorno y complétala con los 4 valores del paso 2:

```bash
cp .env.example .env
```

Abre `.env` con tu editor y completa:

```bash
BOT_TOKEN=123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
ALLOWED_USER_ID=987654321
TELEGRAM_API_ID=12345678
TELEGRAM_API_HASH=abcdef1234567890abcdef1234567890
TELEGRAM_API_BASE_URL=http://127.0.0.1:8081
DOWNLOAD_TMP_DIR=
YTDLP_PATH=yt-dlp
FFMPEG_PATH=ffmpeg
QUALITY_MENU=false
```

> `DOWNLOAD_TMP_DIR` puede dejarse vacío: el bot usa automáticamente una
> carpeta temporal del sistema. Solo complétala si quieres forzar una ruta
> específica (por ejemplo un `tmpfs` en Linux, ver el README).
>
> `YTDLP_PATH` / `FFMPEG_PATH` solo necesitan ruta completa si esos
> ejecutables **no** están en tu `PATH`.
>
> `QUALITY_MENU` puede quedar en `false`: pegar una URL baja directo la mejor
> calidad. Ponlo en `true` si prefieres que el bot te pregunte la calidad con
> botones antes de descargar.

---

## 4. Levanta el servidor local de Telegram

Este servidor es el que permite subir archivos de hasta 2 GB (el límite
público de Telegram es 50 MB).

```bash
docker compose up -d
```

Verifica que esté arriba:

```bash
docker compose ps
```

Debe mostrar el contenedor `telegram-bot-api` como `running`/`healthy`.

---

## 5. Arranca el bot

**Modo desarrollo** (recarga automática al editar código):

```bash
pnpm dev
```

**Modo producción** (compilado, para dejarlo corriendo):

```bash
pnpm build
pnpm start
```

Si todo está bien configurado vas a ver en la terminal:

```
[main] Iniciando bot (long polling)…
[main] Bot @tu_bot_username en línea.
```

---

## 6. Úsalo

1. Abre Telegram y busca tu bot por el username que le diste en BotFather.
2. Envía `/start` — te responde con la bienvenida y la lista de comandos.
3. Envía cualquier URL de video (YouTube, Twitter/X, Instagram, etc.).
4. El bot va a editar un mismo mensaje mostrando el progreso:

   ```
   ⏳ En cola…
   ⬇️ Descargando…
   📤 Subiendo…
   ✅ Listo
   ```

5. Recibirás el archivo directamente en el chat.

**Comandos disponibles** (funcionan siempre, aunque el menú esté desactivado):

| Comando | Qué hace |
|---|---|
| `/audio_only <URL>` | Descarga **solo el audio** en MP3 |
| `/sd <URL>` | Video en **calidad reducida** (480p, pesa menos) |
| `/file <URL>` | Archivo **original sin compresión** (llega como documento, no como video reproducible) |
| `/start`, `/help` | Muestra la bienvenida y los comandos |

> 🎚️ Si pusiste `QUALITY_MENU=true` en tu `.env`, al pegar una URL el bot te
> muestra botones (**Best / 1080p / 720p / 480p / 🎵 Audio / 📁 Original**) para
> que elijas la calidad antes de descargar.

> 🔒 Si escribes desde **otra** cuenta de Telegram (no la del `ALLOWED_USER_ID`),
> el bot no responde nada — es el comportamiento esperado por diseño.

---

## 7. Detener el bot

- Terminal donde corre `pnpm dev` / `pnpm start`: `Ctrl+C` (apaga limpio,
  espera a que termine el job en curso si lo hay).
- Servidor local de Telegram: `docker compose down` (los archivos temporales
  del bot ya se autolimpian en cada descarga, no se pierde nada).

---

## 🆘 Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| Al arrancar dice `Variables de entorno inválidas` | Falta o está mal un valor en `.env` | Revisa la lista de errores impresa, completa el `.env` según el paso 3 |
| El bot no responde nada a ningún mensaje | `ALLOWED_USER_ID` no coincide con tu cuenta | Vuelve a pedirle tu ID a @userinfobot y compáralo con el del `.env` |
| `No se encontró yt-dlp en "yt-dlp"` | yt-dlp no está instalado o no está en el PATH | Instálalo (paso 1) o pon la ruta absoluta en `YTDLP_PATH` |
| `URL no soportada o inválida` | El sitio no está soportado por yt-dlp, o la URL está mal copiada | Prueba `yt-dlp <url>` directo en la terminal para confirmar |
| `No queda espacio en disco` | Se llenó el `DOWNLOAD_TMP_DIR` (o el tmpfs si usas uno) | Libera espacio o aumenta el tamaño del tmpfs |
| Tarda mucho en subir | Es normal en archivos grandes/conexiones lentas; el servidor local permite hasta 2 GB sin cortar | Espera; si falla, revisa que el contenedor Docker siga `running` |
| El archivo supera 2 GB | Límite del Local Bot API Server | No hay forma de subir archivos más grandes por Telegram; descarga en menor calidad si es indispensable |

---

## 📚 Más detalles técnicos

Para arquitectura, estructura de carpetas y decisiones de diseño, ver el
[README.md](README.md) principal del proyecto.
