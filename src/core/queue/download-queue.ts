export type QueueTask = () => Promise<void>;

/**
 * Cola FIFO secuencial in-memory (concurrencia = 1).
 *
 * Pensada para un solo usuario: procesa un job a la vez para no saturar
 * disco/red. Los errores de cada task se capturan para que el loop nunca
 * quede bloqueado.
 */
export class DownloadQueue {
  readonly #tasks: QueueTask[] = [];
  #processing = false;
  #idleWaiters: Array<() => void> = [];

  /** Cantidad de jobs en espera (sin contar el que se está procesando). */
  get pending(): number {
    return this.#tasks.length;
  }

  /** No hay job en curso ni jobs en espera. */
  get isIdle(): boolean {
    return !this.#processing && this.#tasks.length === 0;
  }

  /** Encola un job y arranca el procesamiento si está inactivo. */
  add(task: QueueTask): void {
    this.#tasks.push(task);
    void this.#processNext();
  }

  /**
   * Resuelve cuando el job en curso (si lo hay) y todos los pendientes
   * terminan. Pensada para esperar un apagado limpio (SIGINT/SIGTERM).
   */
  waitUntilIdle(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #processNext(): Promise<void> {
    if (this.#processing) return;
    this.#processing = true;
    try {
      while (this.#tasks.length > 0) {
        const task = this.#tasks.shift();
        if (!task) continue;
        try {
          await task();
        } catch (error) {
          // El task ya debería manejar/notificar sus propios errores.
          // Esto es la última red de seguridad para no romper el loop.
          console.error("[queue] task falló sin ser manejado:", error);
        }
      }
    } finally {
      this.#processing = false;
      const waiters = this.#idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }
}
