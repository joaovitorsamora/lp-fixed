/**
 * RangeCalculator
 * Calcula range ótimo baseado em:
 * - ATR (volatilidade real)
 * - Regime de mercado
 * - EMA para centralização adaptativa
 */

import { BotConfig } from "../../config/bot.config";
import { MarketData } from "./market";

export interface RangeResult {
  lower: number;
  upper: number;
  center: number;
  rangePct: number;       // amplitude percentual total
  isAsymmetric: boolean;  // range assimétrico (ex: tendência)
}

export class RangeCalculator {
  constructor(private config: BotConfig) {}

  calculate(
    market: MarketData,
    position: { lowerPrice: number; upperPrice: number; entryPrice: number }
  ): RangeResult {
    // 1. Calcular amplitude baseada em ATR
    const rangePct = this.calcRangePct(market);

    // 2. Centro adaptativo (EMA ponderada, não preço atual)
    const center = this.calcAdaptiveCenter(market);

    // 3. Ajustar assimetria por regime
    const { lowerMult, upperMult } = this.calcAsymmetry(market);

    const lower = center * (1 - rangePct * lowerMult);
    const upper = center * (1 + rangePct * upperMult);

    return {
      lower,
      upper,
      center,
      rangePct,
      isAsymmetric: lowerMult !== upperMult,
    };
  }

  // ── Amplitude do range ───────────────────────────────────────────────────────

  private calcRangePct(market: MarketData): number {
    const { atrPct } = market;
    const { atrMultiplier, minRangePct, maxRangePct } = this.config;

    // Range proporcional à volatilidade real
    const raw = atrPct * atrMultiplier;

    // Ajuste por regime
    const regimeMultiplier = this.regimeRangeMultiplier(market);

    const adjusted = raw * regimeMultiplier;

    // Clamp entre min e max configurados
    return Math.max(minRangePct, Math.min(maxRangePct, adjusted));
  }

  private regimeRangeMultiplier(market: MarketData): number {
    switch (market.regime) {
      case "SIDEWAYS":       return 0.8;  // range menor em lateral (mais fee)
      case "TRENDING_UP":    return 1.2;  // range maior em tendência
      case "TRENDING_DOWN":  return 1.3;  // range ainda maior em queda
      case "HIGH_VOLATILITY": return 1.5; // range largo para sobreviver
      default: return 1.0;
    }
  }

  // ── Centro adaptativo ────────────────────────────────────────────────────────

  private calcAdaptiveCenter(market: MarketData): number {
    const { currentPrice, ema20 } = market;

    // Ponderar entre EMA e preço atual
    // Evita reposicionar no topo/fundo de spikes
    switch (market.regime) {
      case "SIDEWAYS":
        // Em lateral: usar mais EMA (preço vai voltar para média)
        return ema20 * 0.7 + currentPrice * 0.3;

      case "TRENDING_UP":
        // Em alta: seguir preço mas com amortecimento
        return ema20 * 0.4 + currentPrice * 0.6;

      case "TRENDING_DOWN":
        // Em queda: ser conservador, usar mais EMA
        return ema20 * 0.6 + currentPrice * 0.4;

      case "HIGH_VOLATILITY":
        // Alta vol: centrar exatamente no preço atual
        return currentPrice;

      default:
        return ema20 * 0.5 + currentPrice * 0.5;
    }
  }

  // ── Assimetria por regime ────────────────────────────────────────────────────

  private calcAsymmetry(market: MarketData): { lowerMult: number; upperMult: number } {
    switch (market.regime) {
      case "TRENDING_UP":
        // Dar mais espaço acima — preço tende a subir
        return { lowerMult: 0.4, upperMult: 0.6 };

      case "TRENDING_DOWN":
        // Dar mais espaço abaixo — preço tende a cair
        return { lowerMult: 0.6, upperMult: 0.4 };

      default:
        // Simétrico em lateral e alta volatilidade
        return { lowerMult: 0.5, upperMult: 0.5 };
    }
  }

  // ── Utilitário: verificar se preço saiu do range ─────────────────────────────

  static isPriceOutOfRange(
    currentPrice: number,
    lower: number,
    upper: number,
    deadZonePct: number
  ): { isOut: boolean; side: "below" | "above" | "inside"; deviationPct: number } {
    const deadLower = lower * (1 + deadZonePct);
    const deadUpper = upper * (1 - deadZonePct);

    if (currentPrice < deadLower) {
      const deviationPct = (deadLower - currentPrice) / deadLower;
      return { isOut: true, side: "below", deviationPct };
    }

    if (currentPrice > deadUpper) {
      const deviationPct = (currentPrice - deadUpper) / deadUpper;
      return { isOut: true, side: "above", deviationPct };
    }

    return { isOut: false, side: "inside", deviationPct: 0 };
  }
}
