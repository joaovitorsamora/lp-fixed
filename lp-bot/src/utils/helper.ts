/**
 * TelegramNotifier — Alertas via Telegram
 * Silencioso se TELEGRAM_TOKEN ou TELEGRAM_CHAT_ID não estiverem definidos
 */

export class TelegramNotifier {
  private readonly token   = process.env.TELEGRAM_TOKEN?.trim();
  private readonly chatId  = process.env.TELEGRAM_CHAT_ID?.trim();
  private readonly enabled = !!(this.token && this.chatId &&
                                this.token !== "" && this.chatId !== "TELEGRAM_CHAT_ID");

  async send(message: string): Promise<void> {
    if (!this.enabled) return;

    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    // Retry 2x com timeout de 5s
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5_000);

        const res = await fetch(url, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          signal:  controller.signal,
          body:    JSON.stringify({
            chat_id:    this.chatId,
            text:       message,
            parse_mode: "HTML",
          }),
        });

        clearTimeout(timeout);

        if (!res.ok) {
          console.warn(`[Telegram] HTTP ${res.status} — tentativa ${attempt}/2`);
          continue;
        }

        return; // sucesso
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === 2) {
          console.warn(`[Telegram] Falha após 2 tentativas: ${msg}`);
        }
      }
    }
  }
}
