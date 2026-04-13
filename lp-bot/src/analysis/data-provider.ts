/**
 * DataProvider — Camada de abstração para fontes de dados de mercado
 *
 * Prioridade:
 *   1. On-Chain (RPC direto — slot0 do pool Uniswap V3)
 *   2. GeckoTerminal API (OHLCV + pool data, gratuito, sem API key)
 *   3. Binance API (fallback CEX)
 *   4. Cache local (último dado válido — TTL 5min)
 */

import { ethers, getAddress } from "ethers";
import { MockDataProvider, MockScenario } from "./mock-provider";

export interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PoolData {
  price: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  feeTier: number;
  token0Symbol: string;
  token1Symbol: string;
}

export interface PairConfig {
  geckoNetwork:    string;
  geckoPoolAddress:string;
  binanceSymbol:   string;
}

// ── On-Chain Provider (leitura direta do slot0 do pool) ──────────────────────

const UNIV3_POOL_ABI = [
  "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() external view returns (uint128)",
];

export class OnChainProvider {
  private provider: ethers.JsonRpcProvider;

  constructor(rpcUrl: string) {
    this.provider = new ethers.JsonRpcProvider(rpcUrl);
  }

  async fetchCurrentPoolData(
    poolAddress: string,
    token0Decimals = 6,   // USDC = 6
    token1Decimals = 18   // ARB/ETH/etc = 18
  ): Promise<{ price: number; liquidity: string }> {
    const safeAddress = getAddress(poolAddress);
    const contract = new ethers.Contract(safeAddress, UNIV3_POOL_ABI, this.provider);

    const [slot, liq] = await Promise.all([
      contract.slot0(),
      contract.liquidity(),
    ]);

    const sqrtPriceX96 = BigInt(slot.sqrtPriceX96);
    // Fórmula: price = (sqrtPriceX96 / 2^96)^2 * 10^(decimals0 - decimals1)
    const rawPrice = (Number(sqrtPriceX96) / Math.pow(2, 96)) ** 2;
    const decimalAdj = Math.pow(10, token0Decimals - token1Decimals);
    // Para par token1/token0 (ex: ARB/USDC) inverte-se o preço
    const price = 1 / (rawPrice / decimalAdj);

    return { price, liquidity: liq.toString() };
  }
}

// ── GeckoTerminal Provider ────────────────────────────────────────────────────

export class GeckoTerminalProvider {
  private readonly base = "https://api.geckoterminal.com/api/v2";

  async fetchOHLCV(
    network: string,
    poolAddress: string,
    limit = 50,
    timeframe: "day" | "hour" | "minute" = "hour"
  ): Promise<OHLCV[]> {
    const url = `${this.base}/networks/${network}/pools/${poolAddress}/ohlcv/${timeframe}?limit=${limit}&token=base`;

    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "lp-manager-bot/2.0" },
    });
    if (!res.ok) throw new Error(`GeckoTerminal OHLCV ${res.status}`);

    const data = await res.json() as {
      data: { attributes: { ohlcv_list: [number, number, number, number, number, number][] } };
    };

    return data.data.attributes.ohlcv_list.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts * 1000, open: o, high: h, low: l, close: c, volume: v,
    }));
  }

  async fetchPoolData(network: string, poolAddress: string): Promise<PoolData> {
    const url = `${this.base}/networks/${network}/pools/${poolAddress}`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`GeckoTerminal pool ${res.status}`);

    const data = await res.json() as {
      data: { attributes: {
        base_token_price_usd: string;
        price_change_percentage: { h24: string };
        volume_usd: { h24: string };
        reserve_in_usd: string;
        pool_fee: string;
        name: string;
      }};
    };

    const a = data.data.attributes;
    return {
      price:          parseFloat(a.base_token_price_usd),
      priceChange24h: parseFloat(a.price_change_percentage.h24) / 100,
      volume24h:      parseFloat(a.volume_usd.h24),
      liquidity:      parseFloat(a.reserve_in_usd),
      feeTier:        parseFloat(a.pool_fee || "0.3") / 100,
      token0Symbol:   a.name.split(" / ")[0] ?? "TOKEN0",
      token1Symbol:   a.name.split(" / ")[1]?.split(" ")[0] ?? "TOKEN1",
    };
  }
}

// ── Binance Provider ──────────────────────────────────────────────────────────

export class BinanceProvider {
  private readonly base = "https://api.binance.com/api/v3";

  async fetchOHLCV(symbol: string, interval = "1h", limit = 50): Promise<OHLCV[]> {
    const url = `${this.base}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance klines ${res.status}`);

    const raw = await res.json() as [number, string, string, string, string, string][];
    return raw.map(([ts, o, h, l, c, v]) => ({
      timestamp: ts,
      open:   parseFloat(o), high: parseFloat(h),
      low:    parseFloat(l), close: parseFloat(c),
      volume: parseFloat(v),
    }));
  }

  async fetch24hStats(symbol: string): Promise<{ price: number; change24h: number; volume: number }> {
    const url = `${this.base}/ticker/24hr?symbol=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Binance 24hr ${res.status}`);
    const d = await res.json() as { lastPrice: string; priceChangePercent: string; volume: string };
    return {
      price:     parseFloat(d.lastPrice),
      change24h: parseFloat(d.priceChangePercent) / 100,
      volume:    parseFloat(d.volume),
    };
  }
}

// ── DataFetcher — orquestra com fallback + cache ───────────────────────────────

export class DataFetcher {
  protected gecko   = new GeckoTerminalProvider();
  protected binance = new BinanceProvider();
  protected onChain = new OnChainProvider(
    process.env.RPC_URL || "https://arb1.arbitrum.io/rpc"
  );

  private cache: {
    ohlcv:     OHLCV[];
    poolData:  Partial<PoolData>;
    fetchedAt: number;
    source:    string;
  } | null = null;

  private readonly CACHE_TTL_MS = 5 * 60_000;

  async fetchOHLCV(pair: PairConfig): Promise<{ candles: OHLCV[]; source: string }> {
    // 1. GeckoTerminal
    try {
      const candles = await this.gecko.fetchOHLCV(pair.geckoNetwork, pair.geckoPoolAddress, 50);
      this.updateCache(candles, {});
      return { candles, source: "GeckoTerminal" };
    } catch (e) {
      console.warn(`[DataFetcher] GeckoTerminal OHLCV falhou: ${(e as Error).message}`);
    }

    // 2. Binance fallback
    try {
      const candles = await this.binance.fetchOHLCV(pair.binanceSymbol, "1h", 50);
      this.updateCache(candles, {});
      return { candles, source: "Binance" };
    } catch (e) {
      console.warn(`[DataFetcher] Binance OHLCV falhou: ${(e as Error).message}`);
    }

    // 3. Cache local
    if (this.cache && Date.now() - this.cache.fetchedAt < this.CACHE_TTL_MS) {
      const age = Math.round((Date.now() - this.cache.fetchedAt) / 1000);
      console.warn(`[DataFetcher] Usando cache (${age}s atrás)`);
      return { candles: this.cache.ohlcv, source: `cache` };
    }

    throw new Error("Todas as fontes de dados falharam e cache expirou");
  }

  async fetchPoolData(pair: PairConfig): Promise<Partial<PoolData> & { source: string }> {
    // 1. On-Chain (RPC direto — mais preciso para preço atual)
    try {
      const cleanAddress = getAddress(pair.geckoPoolAddress);
      const data = await this.onChain.fetchCurrentPoolData(cleanAddress);

      let stats = { change24h: 0, volume: 0 };
      try { stats = await this.binance.fetch24hStats(pair.binanceSymbol); } catch { /* ok */ }

      return {
        price:         data.price,
        liquidity:     parseFloat(data.liquidity),
        priceChange24h:stats.change24h,
        volume24h:     stats.volume,
        source:        "On-Chain (RPC)",
      };
    } catch (e) {
      console.warn(`[DataFetcher] On-Chain falhou: ${(e as Error).message}`);
    }

    // 2. GeckoTerminal
    try {
      const pool = await this.gecko.fetchPoolData(pair.geckoNetwork, pair.geckoPoolAddress);
      return { ...pool, source: "GeckoTerminal" };
    } catch (e) {
      console.warn(`[DataFetcher] GeckoTerminal pool falhou: ${(e as Error).message}`);
    }

    // 3. Binance
    try {
      const s = await this.binance.fetch24hStats(pair.binanceSymbol);
      return { price: s.price, priceChange24h: s.change24h, volume24h: s.volume, source: "Binance" };
    } catch { /* silencioso */ }

    return { source: "none" };
  }

  private updateCache(ohlcv: OHLCV[], poolData: Partial<PoolData>): void {
    this.cache = { ohlcv, poolData, fetchedAt: Date.now(), source: "gecko" };
  }

  static closePrices(candles: OHLCV[]): number[] {
    return candles.map(c => c.close);
  }

  get isCacheValid(): boolean {
    return !!this.cache && Date.now() - this.cache.fetchedAt < this.CACHE_TTL_MS;
  }
}

// ── DataFetcherWithMock — suporte a dados sintéticos ─────────────────────────

export class DataFetcherWithMock extends DataFetcher {
  private mock: MockDataProvider | null = null;

  constructor() {
    super();
    if (process.env.USE_MOCK === "true") {
      const scenario = (process.env.MOCK_SCENARIO ?? "sideways") as MockScenario;
      // Base price para ARB (~$0.60)
      this.mock = new MockDataProvider(scenario, 0.60);
    }
  }

  async fetchOHLCV(pair: PairConfig): Promise<{ candles: OHLCV[]; source: string }> {
    if (this.mock) {
      const candles = this.mock.generateOHLCV(50);
      return { candles, source: `mock:${process.env.MOCK_SCENARIO ?? "sideways"}` };
    }
    return super.fetchOHLCV(pair);
  }

  async fetchPoolData(pair: PairConfig): Promise<Partial<PoolData> & { source: string }> {
    if (this.mock) {
      // Pega o último preço gerado consistente com o OHLCV
      const candles = this.mock.generateOHLCV(1);
      const price = candles[0].close;
      return {
        price,
        liquidity:     2_000_000,
        priceChange24h:0,
        volume24h:     3_000_000,
        source:        "mock",
      };
    }
    return super.fetchPoolData(pair);
  }
}
