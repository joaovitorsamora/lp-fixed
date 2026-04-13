/**
 * RebalanceDecider
 * O "cérebro" do bot.
 * Aplica a TRÍADE de condições antes de qualquer ação:
 *   1. Preço saiu do range (com dead zone)
 *   2. Desvio mínimo atingido
 *   3. Cooldown respeitado
 *   4. Economicamente justificado (IL vs fee)
 */

import { BotConfig } from "../../config/bot.config";
import { MarketData } from "../analysis/market";
import { RangeCalculator, RangeResult } from "../analysis/range";

export interface DecisionInput {
  market: MarketData;
  idealRange: RangeResult;
  position: {
    lowerPrice: number;
    upperPrice: number;
    entryPrice: number;
    liquidityUSD: number;
    feeAccumulatedUSD: number;
    lastRebalanceTs: number;
  };
  config: BotConfig;
}

export interface Decision {
  shouldRebalance: boolean;
  reason: string;
  checks: {
    priceOutOfRange: boolean;
    deviationSufficient: boolean;
    cooldownPassed: boolean;
    economicallyJustified: boolean;
  };
  estimatedIL: number;
  estimatedFeeIfStay: number;
}

export class RebalanceDecider {
  constructor(private config: BotConfig) {}

  evaluate(input: DecisionInput): Decision {
    const { market, idealRange, position, config } = input;

    // Sem posição ainda — primeiro deploy
    if (position.lowerPrice === 0) {
      return this.approve("Posição inicial — primeiro deploy", input);
    }

    // ── Check 1: Preço saiu do range? ────────────────────────────────────────
    const rangeCheck = RangeCalculator.isPriceOutOfRange(
      market.currentPrice,
      position.lowerPrice,
      position.upperPrice,
      config.deadZonePct
    );

    if (!rangeCheck.isOut) {
      return this.deny("Preço dentro do range (dead zone)", {
        priceOutOfRange: false,
        deviationSufficient: false,
        cooldownPassed: false,
        economicallyJustified: false,
      }, input);
    }

    // ── Check 2: Desvio suficiente? ──────────────────────────────────────────
    const deviationOk = rangeCheck.deviationPct >= config.minDeviationPct;

    if (!deviationOk) {
      return this.deny(
        `Desvio insuficiente: ${(rangeCheck.deviationPct * 100).toFixed(2)}% < ${(config.minDeviationPct * 100).toFixed(2)}%`,
        { priceOutOfRange: true, deviationSufficient: false, cooldownPassed: false, economicallyJustified: false },
        input
      );
    }

    // ── Check 3: Cooldown respeitado? ────────────────────────────────────────
    const elapsed = Date.now() - position.lastRebalanceTs;
    const cooldownOk = elapsed >= config.cooldownMs;

    if (!cooldownOk) {
      const remaining = Math.ceil((config.cooldownMs - elapsed) / 60_000);
      return this.deny(
        `Cooldown ativo: ${remaining}min restantes`,
        { priceOutOfRange: true, deviationSufficient: true, cooldownPassed: false, economicallyJustified: false },
        input
      );
    }

    // ── Check 4: Economicamente justificado? ─────────────────────────────────
    const il = this.estimateIL(market.currentPrice, position.entryPrice, position.liquidityUSD);
    const feeIfStay = this.estimateFeeIfStay(position, market, config);
    const totalCost = il + config.gasCostUSD;

    const economicOk = totalCost > feeIfStay;

    if (!economicOk) {
      return this.deny(
        `Não vale economicamente: custo $${totalCost.toFixed(2)} < fee projetada $${feeIfStay.toFixed(2)}`,
        { priceOutOfRange: true, deviationSufficient: true, cooldownPassed: true, economicallyJustified: false },
        input,
        il,
        feeIfStay
      );
    }

    // ── Todos os checks passaram ─────────────────────────────────────────────
    return {
      shouldRebalance: true,
      reason: `✅ Tríade completa | Saída: ${rangeCheck.side} ${(rangeCheck.deviationPct * 100).toFixed(2)}% | IL: $${il.toFixed(2)} | Fee projetada: $${feeIfStay.toFixed(2)}`,
      checks: {
        priceOutOfRange: true,
        deviationSufficient: true,
        cooldownPassed: true,
        economicallyJustified: true,
      },
      estimatedIL: il,
      estimatedFeeIfStay: feeIfStay,
    };
  }

  // ── Estimativa de Impermanent Loss ───────────────────────────────────────────

  private estimateIL(currentPrice: number, entryPrice: number, liquidityUSD: number): number {
    if (entryPrice === 0 || liquidityUSD === 0) return 0;

    const k = currentPrice / entryPrice;
    const ilFactor = (2 * Math.sqrt(k)) / (1 + k) - 1;
    return Math.abs(ilFactor) * liquidityUSD;
  }

  // ── Estimativa de fee futura se ficar ────────────────────────────────────────
  // Quanto de fee vou perder se AGIR agora vs ficar no range atual

  private estimateFeeIfStay(
    position: DecisionInput["position"],
    market: MarketData,
    config: BotConfig
  ): number {
    // Estimativa conservadora: fee por hora * horas estimadas ainda no range
    // Simplificação: preço está fora do range — fee = 0 enquanto fora
    // Então "custo de não agir" = fee que já estava acumulando (perdida)

    const feePerHour = (position.liquidityUSD * config.feeRatePct * 24) / 24;

    // Estimar quantas horas até o preço eventualmente sair mais
    // Aqui: simplificamos em 2h de fee média
    return feePerHour * 2;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private approve(reason: string, input: DecisionInput): Decision {
    const il = this.estimateIL(
      input.market.currentPrice,
      input.position.entryPrice,
      input.position.liquidityUSD
    );
    return {
      shouldRebalance: true,
      reason,
      checks: { priceOutOfRange: true, deviationSufficient: true, cooldownPassed: true, economicallyJustified: true },
      estimatedIL: il,
      estimatedFeeIfStay: 0,
    };
  }

  private deny(
    reason: string,
    checks: Decision["checks"],
    input: DecisionInput,
    il = 0,
    feeIfStay = 0
  ): Decision {
    return {
      shouldRebalance: false,
      reason,
      checks,
      estimatedIL: il,
      estimatedFeeIfStay: feeIfStay,
    };
  }
}
