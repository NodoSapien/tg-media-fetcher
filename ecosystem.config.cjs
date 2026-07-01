// Extensión .cjs a propósito: el proyecto es "type": "module" y PM2 necesita
// que su archivo de config sea CommonJS.
module.exports = {
  apps: [
    {
      name: "tg-media-fetcher",
      script: "dist/index.js",
      cwd: __dirname,
      autorestart: true,
      // El apagado limpio (ver src/index.ts) espera a que termine el job en
      // curso antes de salir; el default de PM2 (1.6s) lo mataría de un
      // SIGKILL antes de que eso pase.
      kill_timeout: 30_000,
    },
  ],
};
