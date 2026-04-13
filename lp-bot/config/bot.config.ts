import { PairConfig } from "../src/analysis/data-provider";

export interface BotConfig {
  pair: string;
  pairConfig: PairConfig;

  initialLiquidityUSD: number;

  intervalMs: number;
  jitterMs: number;
  cooldownMs: number;

  minRangePct: number;
  maxRangePct: number;
  atrPeriod: number;
  atrMultiplier: number;
  deadZonePct: number;

  minDeviationPct: number;
  maxSlippageBps: number;

  maxVolatilityPct: number;
  maxPriceDropPct: number;

  feeRatePct: number;
  gasCostUSD: number;

  // Uniswap V3 tick spacing por fee tier:
  //   0.01% = 1 | 0.05% = 10 | 0.30% = 60 | 1.00% = 200
  tickSpacing: number;
}

export const DEFAULT_CONFIG: BotConfig = {
  pair: "ETH/USDC-ARB",

  pairConfig: {
    geckoNetwork:    "arbitrum",
    geckoPoolAddress:"0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443",
    binanceSymbol:   "ETHUSDT",
  },

  // 🔥 já pensando em 1 mês de aporte
  initialLiquidityUSD: 120,

  intervalMs:  60_000,
  jitterMs:    20_000,
  cooldownMs:  10 * 60_000, // 10 min

  // 📊 RANGE equilibrado (nem muito agressivo nem passivo)
  minRangePct:     0.02,
  maxRangePct:     0.12,
  atrPeriod:       14,
  atrMultiplier:   2.5,
  deadZonePct:     0.003,

  // 🎯 ainda sensível, mas mais profissional
  minDeviationPct: 0.01, // 1%
  maxSlippageBps:  80,

  // 🛡️ controle de risco
  maxVolatilityPct: 0.20,
  maxPriceDropPct:  0.12,

  // 💸 custos realistas
  feeRatePct:  0.0005,
  gasCostUSD:  0.15,

  tickSpacing: 10,
};
export const PAIRS = {
  "ETH/USDC": DEFAULT_CONFIG.pairConfig,

  "WBTC/USDC": {
    geckoNetwork:    "eth",
    geckoPoolAddress:"0x99ac8cA7087fA4A2A1FB6357269965A2014ABc35",
    binanceSymbol:   "BTCUSDT",
  },

  "ETH/USDC-ARB": {
    geckoNetwork:    "arbitrum",
    geckoPoolAddress:"0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443",
    binanceSymbol:   "ETHUSDT",
  },

  "MATIC/USDC": {
    geckoNetwork:    "polygon",
    geckoPoolAddress:"0xA374094527e1673A86dE625aa59517c5dE346d32",
    binanceSymbol:   "MATICUSDT",
  },
} satisfies Record<string, PairConfig>;
