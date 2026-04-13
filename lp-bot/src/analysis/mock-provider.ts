/**
 * MockProvider — Dados sintéticos para desenvolvimento local
 * Simula diferentes regimes de mercado para testar a lógica do bot
 *
 * Uso: export USE_MOCK=true npm run dev
 */

import { OHLCV } from "./data-provider";

export type MockScenario =
  | "sideways"       // mercado lateral — bot deve ficar quieto
  | "trending_up"    // alta gradual — range assimétrico acima
  | "trending_down"  // queda gradual — range assimétrico abaixo
  | "pump"           // pump rápido — circuit breaker deve ativar
  | "whipsaw"        // vai e volta — dead zone deve filtrar
  | "slow_drift";    // saída lenta do range — deve rebalancear

export class MockDataProvider {
  private scenario: MockScenario;
  private tick = 0;
  private basePrice: number;

  constructor(scenario: MockScenario = "sideways", basePrice = 3200) {
    this.scenario = scenario;
    this.basePrice = basePrice;
    console.log(`[MockProvider] 🎭 Cenário: ${scenario.toUpperCase()} | Base: $${basePrice}`);
  }

  generateOHLCV(count = 50): OHLCV[] {
    const candles: OHLCV[] = [];
    let price = this.basePrice;
    const now = Date.now();

    for (let i = 0; i < count; i++) {
      const priceDelta = this.getPriceDelta(i, count, price);
      const open = price;
      const close = price + priceDelta;
      const high = Math.max(open, close) + Math.abs(priceDelta) * 0.3;
      const low = Math.min(open, close) - Math.abs(priceDelta) * 0.3;
      const volume = 1_000_000 + Math.random() * 500_000;

      candles.push({
        timestamp: now - (count - i) * 3_600_000, // 1h por candle
        open,
        high,
        low,
        close,
        volume,
      });

      price = close;
    }

    this.tick++;
    return candles;
  }

  private getPriceDelta(i: number, total: number, currentPrice: number): number {
    const noise = (Math.random() - 0.5) * currentPrice * 0.004; // ruído base 0.4%

    switch (this.scenario) {
      case "sideways":
        // Oscilação em torno da média — pouco movimento direcional
        return noise * 0.5;

      case "trending_up":
        // Alta gradual ~0.3% por candle + ruído
        return currentPrice * 0.003 + noise;

      case "trending_down":
        // Queda gradual ~0.25% por candle + ruído
        return -currentPrice * 0.0025 + noise;

      case "pump":
        // Lateral nas primeiras 80% das velas, pump brutal no final
        if (i > total * 0.8) {
          return currentPrice * 0.04 + noise; // +4% por candle = pump
        }
        return noise * 0.3;

      case "whipsaw":
        // Oscilação rápida vai-e-volta — testar dead zone
        return currentPrice * 0.015 * Math.sin(i * 0.8) + noise;

      case "slow_drift":
        // Deriva lenta para fora do range original
        return currentPrice * 0.006 + noise * 0.3;

      default:
        return noise;
    }
  }

  // Gerar uma única vela "ao vivo" incrementando o preço
  nextLiveTick(lastPrice: number): number {
    const delta = this.getPriceDelta(this.tick, 100, lastPrice);
    return Math.max(lastPrice + delta, 1);
  }
}

// ── Cenários para testes manuais ─────────────────────────────────────────────

export const MOCK_SCENARIOS: Record<MockScenario, string> = {
  sideways:      "Lateral — bot deve recusar a maioria dos rebalances",
  trending_up:   "Alta — range assimétrico acima, rebalance eventual",
  trending_down: "Queda — range assimétrico abaixo, rebalance defensivo",
  pump:          "Pump — circuit breaker deve pausar o bot no pico",
  whipsaw:       "Vai-e-volta — dead zone deve filtrar ruído",
  slow_drift:    "Deriva lenta — deve triggar rebalance após cooldown",
};
