/**
 * MarketAnalyzer
 * Responsável por: ATR, regime de mercado, circuit breaker
 * Dados reais via GeckoTerminal → Binance → cache local
 */

import { DataFetcherWithMock as DataFetcher, PairConfig } from "./data-provider";

export type MarketRegime = "TRENDING_UP" | "TRENDING_DOWN" | "SIDEWAYS" | "HIGH_VOLATILITY";

export interface MarketData {
  currentPrice: number;
  ema20: number;
  ema50: number;
  atr: number;
  atrPct: number;
  volatility1h: number;
  adx: number;
  regime: MarketRegime;
  circuitBreakerTriggered: boolean;
  prices: number[];
  dataSource: string;
  volume24h?: number;
  liquidity?: number;
}

export class MarketAnalyzer {
  private fetcher = new DataFetcher();

  async analyze(pairConfig: PairConfig): Promise<MarketData> {
    // Buscar candles reais (GeckoTerminal → Binance → cache)
    const { candles, source } = await this.fetcher.fetchOHLCV(pairConfig);
    const prices = DataFetcher.closePrices(candles);

    // Dados de pool (não bloqueia se falhar)
    let volume24h: number | undefined;
    let liquidity: number | undefined;
    try {
      const pool = await this.fetcher.fetchPoolData(pairConfig);
      volume24h = pool.volume24h;
      liquidity = pool.liquidity;
    } catch { /* não crítico */ }

    const currentPrice = prices[prices.length - 1];
    const atr = this.calcATR(prices, 14);
    const atrPct = atr / currentPrice;
    const ema20 = this.calcEMA(prices, 20);
    const ema50 = this.calcEMA(prices, 50);
    const adx = this.calcADX(prices, 14);
    const volatility1h = Math.abs(
      (prices[prices.length - 1] - prices[prices.length - 6]) / prices[prices.length - 6]
    );

    const regime = this.detectRegime({ currentPrice, ema20, ema50, adx, atrPct });
    const circuitBreakerTriggered = this.checkCircuitBreaker({ atrPct, volatility1h });

    return {
      currentPrice,
      ema20,
      ema50,
      atr,
      atrPct,
      volatility1h,
      adx,
      regime,
      circuitBreakerTriggered,
      prices,
      dataSource: source,
      volume24h,
      liquidity,
    };
  }

  // ── Indicadores ─────────────────────────────────────────────────────────────

  calcATR(prices: number[], period: number): number {
    if (prices.length < period + 1) return prices[prices.length - 1] * 0.02;
    const trueRanges: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      trueRanges.push(Math.abs(prices[i] - prices[i - 1]));
    }
    const recent = trueRanges.slice(-period);
    return recent.reduce((a, b) => a + b, 0) / recent.length;
  }

  calcEMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1];
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  calcADX(prices: number[], period: number): number {
    if (prices.length < period * 2) return 20;
    let dmPlus = 0, dmMinus = 0, tr = 0;
    const recent = prices.slice(-period - 1);
    for (let i = 1; i < recent.length; i++) {
      const up = recent[i] - recent[i - 1];
      const down = recent[i - 1] - recent[i];
      dmPlus += up > 0 && up > down ? up : 0;
      dmMinus += down > 0 && down > up ? down : 0;
      tr += Math.abs(recent[i] - recent[i - 1]);
    }
    if (tr === 0) return 0;
    const diPlus = (dmPlus / tr) * 100;
    const diMinus = (dmMinus / tr) * 100;
    const dx = Math.abs(diPlus - diMinus) / (diPlus + diMinus + 0.001) * 100;
    return dx;
  }

  // ── Regime de mercado ────────────────────────────────────────────────────────

  private detectRegime(data: {
    currentPrice: number;
    ema20: number;
    ema50: number;
    adx: number;
    atrPct: number;
  }): MarketRegime {
    const { currentPrice, ema20, ema50, adx, atrPct } = data;
    if (atrPct > 0.05) return "HIGH_VOLATILITY";
    if (adx > 25) {
      if (currentPrice > ema20 && ema20 > ema50) return "TRENDING_UP";
      if (currentPrice < ema20 && ema20 < ema50) return "TRENDING_DOWN";
    }
    return "SIDEWAYS";
  }

  // ── Circuit breaker ──────────────────────────────────────────────────────────

  private checkCircuitBreaker(data: {
    atrPct: number;
    volatility1h: number;
  }): boolean {
    const { atrPct, volatility1h } = data;
    if (atrPct > 0.08) return true;
    if (volatility1h > 0.12) return true;
    return false;
  }
}
