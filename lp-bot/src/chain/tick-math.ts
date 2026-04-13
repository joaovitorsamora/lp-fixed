/**
 * TickMath — Conversão entre preço USD e ticks do Uniswap V3
 *
 * Uniswap V3 representa ranges como pares de ticks.
 * Cada tick corresponde a um preço: price = 1.0001^tick
 * O bot trabalha com preços em USD — este módulo faz a ponte.
 *
 * Tick spacing por fee tier:
 *   0.01% → spacing 1
 *   0.05% → spacing 10    ← mais comum para stablecoins + ETH
 *   0.30% → spacing 60
 *   1.00% → spacing 200
 */

export interface TickRange {
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  tickSpacing: number;
}

export class TickMath {
  // Uniswap V3 tick bounds
  static readonly MIN_TICK = -887272;
  static readonly MAX_TICK =  887272;

  /**
   * Converte preço USD → tick
   * Para par token1/token0 (ex: ETH/USDC):
   *   tick = log(price) / log(1.0001)
   */
  static priceToTick(price: number): number {
    if (price <= 0) throw new Error("Preço deve ser > 0");
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }

  /**
   * Converte tick → preço USD
   */
  static tickToPrice(tick: number): number {
    return Math.pow(1.0001, tick);
  }

  /**
   * Alinha tick ao tick spacing do pool
   * Floor para tickLower, ceil para tickUpper (garante que o range cobre o preço)
   */
  static alignTick(tick: number, tickSpacing: number, direction: "floor" | "ceil"): number {
    if (direction === "floor") {
      return Math.floor(tick / tickSpacing) * tickSpacing;
    }
    return Math.ceil(tick / tickSpacing) * tickSpacing;
  }

  /**
   * Converte um range de preços USD em par de ticks alinhados
   * Esta é a função principal usada pelo bot
   *
   * @param lowerPriceUSD  preço inferior do range
   * @param upperPriceUSD  preço superior do range
   * @param tickSpacing    tick spacing do pool (padrão 10 = 0.05% fee)
   */
  static priceRangeToTicks(
    lowerPriceUSD: number,
    upperPriceUSD: number,
    tickSpacing = 10
  ): TickRange {
    if (lowerPriceUSD >= upperPriceUSD) {
      throw new Error(`Range inválido: lower(${lowerPriceUSD}) >= upper(${upperPriceUSD})`);
    }

    const rawTickLower = this.priceToTick(lowerPriceUSD);
    const rawTickUpper = this.priceToTick(upperPriceUSD);

    // Alinhar: tickLower → floor, tickUpper → ceil
    // Garante que o range engloba os preços calculados
    const tickLower = this.clampTick(
      this.alignTick(rawTickLower, tickSpacing, "floor"),
      tickSpacing
    );
    const tickUpper = this.clampTick(
      this.alignTick(rawTickUpper, tickSpacing, "ceil"),
      tickSpacing
    );

    // Garantir que ticks são diferentes após alinhamento
    if (tickLower >= tickUpper) {
      throw new Error(`Ticks iguais após alinhamento: ${tickLower} — considere um range maior`);
    }

    return {
      tickLower,
      tickUpper,
      priceLower: this.tickToPrice(tickLower),
      priceUpper: this.tickToPrice(tickUpper),
      tickSpacing,
    };
  }

  /**
   * Clamp tick dentro dos bounds do Uniswap V3
   */
  static clampTick(tick: number, tickSpacing: number): number {
    const minAligned = Math.ceil(this.MIN_TICK / tickSpacing) * tickSpacing;
    const maxAligned = Math.floor(this.MAX_TICK / tickSpacing) * tickSpacing;
    return Math.max(minAligned, Math.min(maxAligned, tick));
  }

  /**
   * Verificar se um preço está dentro do range de ticks
   */
  static isPriceInRange(price: number, tickLower: number, tickUpper: number): boolean {
    const tick = this.priceToTick(price);
    return tick >= tickLower && tick < tickUpper;
  }

  /**
   * Calcular % do preço atual em relação ao range [0 = no lower, 1 = no upper]
   */
  static pricePositionInRange(
    currentPrice: number,
    tickLower: number,
    tickUpper: number
  ): number {
    const currentTick = this.priceToTick(currentPrice);
    if (currentTick <= tickLower) return 0;
    if (currentTick >= tickUpper) return 1;
    return (currentTick - tickLower) / (tickUpper - tickLower);
  }

  /**
   * Resumo legível de um range de ticks
   */
  static describe(tickLower: number, tickUpper: number): string {
    const lower = this.tickToPrice(tickLower).toFixed(2);
    const upper = this.tickToPrice(tickUpper).toFixed(2);
    const width = ((this.tickToPrice(tickUpper) / this.tickToPrice(tickLower) - 1) * 100).toFixed(1);
    return `[$${lower} — $${upper}] (±${width}% de amplitude)`;
  }
}
