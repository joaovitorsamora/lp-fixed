/**
 * MetricsTracker
 * Registra tudo que importa para saber se o bot está lucrando
 */

import { Decision } from "../strategy/decider";

interface RebalanceRecord {
  ts: number;
  fromRange: [number, number];
  toRange: [number, number];
  price: number;
  feeCollected: number;
  gasCostUSD: number;
}

export class MetricsTracker {
  private rebalances: RebalanceRecord[] = [];
  private decisionsTotal = 0;
  private decisionsPrevented = 0;
  private totalErrors = 0;
  private _consecutiveErrors = 0;  // reset após sucesso
  private circuitBreakers = 0;
  private totalFeeCollected = 0;
  private totalGasCost = 0;
  private startTs = Date.now();

  recordDecision(decision: Decision): void {
    this.decisionsTotal++;
    if (!decision.shouldRebalance) {
      this.decisionsPrevented++;
    } else {
      // Sucesso na decisão → resetar contador consecutivo
      this._consecutiveErrors = 0;
    }
  }

  recordRebalance(data: { fromRange: [number, number]; toRange: [number, number]; price: number; feeCollected: number; gasCostUSD: number }): void {
    this.rebalances.push({ ...data, ts: Date.now() });
    this.totalFeeCollected += data.feeCollected;
    this.totalGasCost      += data.gasCostUSD;
    this._consecutiveErrors = 0;
  }

  recordError(): void {
    this.totalErrors++;
    this._consecutiveErrors++;
  }

  recordCircuitBreaker(): void {
    this.circuitBreakers++;
  }

  /** Erros seguidos sem sucesso — usado para acionar circuit breaker automático */
  get consecutiveErrors(): number {
    return this._consecutiveErrors;
  }

  printSummary(): void {
    const uptimeMin = Math.round((Date.now() - this.startTs) / 60_000);
    const preventionRate = this.decisionsTotal > 0
      ? ((this.decisionsPrevented / this.decisionsTotal) * 100).toFixed(1)
      : "0";

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 MÉTRICAS DO BOT LP MANAGER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏱️  Uptime:            ${uptimeMin} min
🔄  Rebalances:        ${this.rebalances.length}
✋  Ações prevenidas:  ${this.decisionsPrevented} (${preventionRate}% das decisões)
💰  Fee coletada:      $${this.totalFeeCollected.toFixed(4)}
⛽  Custo gas:         $${this.totalGasCost.toFixed(4)}
📈  PnL líquido:       $${(this.totalFeeCollected - this.totalGasCost).toFixed(4)}
⚡  Circuit breakers:  ${this.circuitBreakers}
❌  Erros totais:      ${this.totalErrors}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    `);
  }

  getSummary() {
    return {
      rebalances:          this.rebalances.length,
      decisionsPrevented:  this.decisionsPrevented,
      totalFeeCollected:   this.totalFeeCollected,
      totalGasCost:        this.totalGasCost,
      netPnL:              this.totalFeeCollected - this.totalGasCost,
      consecutiveErrors:   this._consecutiveErrors,
    };
  }
}
