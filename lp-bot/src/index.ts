/**
 * LP Manager Bot — OFF-CHAIN engine
 * Loop completo: análise → decisão → execução on-chain via viem
 */

import { BotConfig, DEFAULT_CONFIG } from "../config/bot.config";
import { MarketAnalyzer, MarketData } from "./analysis/market";
import { RangeCalculator } from "./analysis/range";
import { RebalanceDecider } from "./strategy/decider";
import { MetricsTracker } from "./utils/metrics";
import { Logger } from "./utils/logger";
import { TelegramNotifier } from "./utils/helper";
import { KeeperClient, createKeeperClientFromEnv } from "./chain/keeper-client";
import { TickMath } from "./chain/tick-math";

interface Position {
  lowerPrice:        number;
  upperPrice:        number;
  centerPrice:       number;
  entryPrice:        number;
  liquidityUSD:      number;
  feeAccumulatedUSD: number;
  lastRebalanceTs:   number;
  tickLower:         number;
  tickUpper:         number;
}

class LPManagerBot {
  private config:   BotConfig;
  private market:   MarketAnalyzer;
  private range:    RangeCalculator;
  private decider:  RebalanceDecider;
  private metrics:  MetricsTracker;
  private log:      Logger;
  private telegram: TelegramNotifier;
  private keeper:   KeeperClient | null;

  private lastFeeCheckpoint = 0;

  private position: Position = {
    lowerPrice:        0,
    upperPrice:        0,
    centerPrice:       0,
    entryPrice:        0,
    liquidityUSD:      0,
    feeAccumulatedUSD: 0,
    lastRebalanceTs:   0,
    tickLower:         0,
    tickUpper:         0,
  };

  constructor(config: BotConfig = DEFAULT_CONFIG) {
    this.config   = config;
    this.market   = new MarketAnalyzer();
    this.range    = new RangeCalculator(config);
    this.decider  = new RebalanceDecider(config);
    this.metrics  = new MetricsTracker();
    this.log      = new Logger("LPBot");
    this.telegram = new TelegramNotifier();
    this.keeper   = createKeeperClientFromEnv();

    if (this.keeper) {
      const dryRun = process.env.DRY_RUN !== "false";
      this.log.info(`🔗 Modo ON-CHAIN | contrato: ${process.env.KEEPER_CONTRACT}${dryRun ? " [DRY_RUN]" : ""}`);
    } else {
      this.log.info(`🧪 Modo SIMULADO — sem contrato (defina RPC_URL, PRIVATE_KEY, KEEPER_CONTRACT)`);
    }
  }

  // ── Acumulação de fee (estimativa realista) ───────────────────────────────

  private accumulateFees(market: MarketData): void {
    if (this.position.liquidityUSD === 0) return;

    const inRange =
      market.currentPrice >= this.position.lowerPrice &&
      market.currentPrice <= this.position.upperPrice;

    if (!inRange) return;

    const seconds          = this.config.intervalMs / 1000;
    const volume24h        = market.volume24h ?? 1_000_000;
    const volumePerSecond  = volume24h / 86_400;
    const volumeThisTick   = volumePerSecond * seconds;

    // Boost de volatilidade: mais volatilidade = mais volume = mais fee
    const volatilityBoost  = Math.min(market.atrPct / 0.01, 3);
    const adjustedVolume   = volumeThisTick * volatilityBoost;

    // Participação proporcional na liquidez do pool
    const poolLiquidity    = market.liquidity ?? 1_000_000;
    const share            = this.position.liquidityUSD / poolLiquidity;

    // Penalidade por distância do centro do range
    const mid              = (this.position.lowerPrice + this.position.upperPrice) / 2;
    const dist             = Math.abs(market.currentPrice - mid) / mid;
    const efficiency       = Math.max(0.2, 1 - dist * 2);

    this.position.feeAccumulatedUSD +=
      adjustedVolume * this.config.feeRatePct * share * efficiency;

    // Notificar a cada $0.50 acumulado
    if (this.position.feeAccumulatedUSD - this.lastFeeCheckpoint > 0.5) {
      this.lastFeeCheckpoint = this.position.feeAccumulatedUSD;
      this.log.info(`💰 Fee acumulando: $${this.position.feeAccumulatedUSD.toFixed(4)}`);
      this.telegram.send(`💰 Fee acumulada: <b>$${this.position.feeAccumulatedUSD.toFixed(4)}</b>`);
    }
  }

  // ── Loop principal ────────────────────────────────────────────────────────

  async run(): Promise<void> {
    this.log.info(`🤖 LP Manager Bot iniciando | Par: ${this.config.pair}`);
    await this.telegram.send(`🤖 <b>LP Manager Bot iniciado</b>\nPar: ${this.config.pair}`);
    await this.syncOnChainState();

    while (true) {
      try {
        await this.tick();
      } catch (err) {
        this.log.error("Erro no tick:", err);
        this.metrics.recordError();

        // Circuit breaker automático após 3 erros consecutivos
        if (this.metrics.consecutiveErrors >= 3 && this.keeper) {
          const reason = `Bot: ${this.metrics.consecutiveErrors} erros consecutivos`;
          this.log.warn(`⚡ Acionando circuit breaker on-chain | ${reason}`);
          await this.keeper.triggerCircuitBreaker(reason).catch(() => {});
          await this.telegram.send(`⚡ <b>Circuit breaker ativado</b>\n${reason}`);
        }
      }

      const jitter = Math.random() * this.config.jitterMs;
      await this.sleep(this.config.intervalMs + jitter);
    }
  }

  private async tick(): Promise<void> {
    // 1. Dados de mercado
    const market = await this.market.analyze(this.config.pairConfig);

    // 2. Acumular fee (sempre, se estiver no range)
    this.accumulateFees(market);

    this.log.info(
      `Preço: $${market.currentPrice.toFixed(4)} | ` +
      `Fee: $${this.position.feeAccumulatedUSD.toFixed(4)} | ` +
      `Regime: ${market.regime} | ` +
      `ATR: ${(market.atrPct * 100).toFixed(2)}% | ` +
      `Fonte: ${market.dataSource}`
    );

    // 3. Circuit breaker off-chain (volatilidade extrema)
    if (market.circuitBreakerTriggered) {
      this.log.warn(
        `⚡ Circuit breaker OFF-CHAIN | ATR ${(market.atrPct * 100).toFixed(1)}% | Vol1h ${(market.volatility1h * 100).toFixed(1)}%`
      );
      this.metrics.recordCircuitBreaker();

      // Propagar para o contrato se não estiver pausado
      if (this.keeper && !(await this.keeper.isPaused())) {
        const reason = `Alta volatilidade: ATR ${(market.atrPct * 100).toFixed(1)}%`;
        await this.keeper.triggerCircuitBreaker(reason).catch(e =>
          this.log.error("Erro ao acionar CB on-chain:", e)
        );
        await this.telegram.send(`⚡ <b>Circuit breaker on-chain ativado</b>\n${reason}`);
      }
      return;
    }

    // 4. Verificar se o contrato permite rebalancear
    if (this.keeper) {
      const { ok, reason } = await this.keeper.canRebalance();
      if (!ok) {
        this.log.info(`🔒 Contrato bloqueado | ${reason}`);
        return;
      }
    }

    // 5. Calcular range ideal → converter para ticks
    const idealRange = this.range.calculate(market, this.position);
    const ticks = TickMath.priceRangeToTicks(
      idealRange.lower,
      idealRange.upper,
      this.config.tickSpacing
    );

    this.log.debug(
      `Range ideal: ${TickMath.describe(ticks.tickLower, ticks.tickUpper)} | ` +
      `${idealRange.isAsymmetric ? "assimétrico" : "simétrico"}`
    );

    // 6. Decisão off-chain (tríade de condições)
    const decision = this.decider.evaluate({
      market,
      idealRange,
      position: this.position,
      config:   this.config,
    });

    this.metrics.recordDecision(decision);

    if (!decision.shouldRebalance) {
      this.log.info(`✋ ${decision.reason}`);
      return;
    }

    // 7. Executar rebalance
    const isFirstDeploy = this.position.tickLower === 0 && this.position.tickUpper === 0;
    this.log.info(`🔄 ${isFirstDeploy ? "ABRINDO POSIÇÃO" : "REBALANCEANDO"} | ${decision.reason}`);
    this.log.info(`   ${TickMath.describe(ticks.tickLower, ticks.tickUpper)}`);

    await this.executeRebalance(ticks, market.currentPrice, idealRange.center, isFirstDeploy);
  }

  // ── Execução on-chain ─────────────────────────────────────────────────────

  private async executeRebalance(
    ticks:          { tickLower: number; tickUpper: number },
    currentPrice:   number,
    centerPrice:    number,
    isFirstDeploy:  boolean
  ): Promise<void> {
    const prev = { ...this.position };

    // ── Chamar contrato on-chain (se disponível) ──────────────────────────
    if (this.keeper) {
      try {
        if (isFirstDeploy) {
          await this.keeper.openPosition(
            ticks.tickLower,
            ticks.tickUpper,
            currentPrice,
            BigInt(Math.round(this.config.initialLiquidityUSD))
          );
        } else {
          await this.keeper.rebalance({
            newTickLower:    ticks.tickLower,
            newTickUpper:    ticks.tickUpper,
            currentPriceUSD: currentPrice,
            slippageBps:     this.config.maxSlippageBps,
          });
        }
      } catch (err) {
        this.log.error("❌ Falha na execução on-chain:", err);
        this.metrics.recordError();
        return; // não atualiza estado local se a tx falhou
      }
    }

    // ── Atualizar estado local (espelho do on-chain) ───────────────────────
    this.position = {
      lowerPrice:        TickMath.tickToPrice(ticks.tickLower),
      upperPrice:        TickMath.tickToPrice(ticks.tickUpper),
      centerPrice,
      entryPrice:        currentPrice,
      liquidityUSD:      prev.liquidityUSD || this.config.initialLiquidityUSD,
      feeAccumulatedUSD: 0,
      lastRebalanceTs:   Date.now(),
      tickLower:         ticks.tickLower,
      tickUpper:         ticks.tickUpper,
    };

    this.lastFeeCheckpoint = 0;

    this.metrics.recordRebalance({
      fromRange:    [prev.tickLower, prev.tickUpper],
      toRange:      [ticks.tickLower, ticks.tickUpper],
      price:        currentPrice,
      feeCollected: prev.feeAccumulatedUSD,
      gasCostUSD:   this.config.gasCostUSD, // ← usa o custo real da config (0.30 para Arbitrum)
    });

    const msg = `🔄 <b>${isFirstDeploy ? "Posição aberta" : "Rebalance"}</b>\n` +
                `💰 Fee coletada: <b>$${prev.feeAccumulatedUSD.toFixed(4)}</b>\n` +
                `📍 ${TickMath.describe(ticks.tickLower, ticks.tickUpper)}`;

    this.log.info(`✅ ${isFirstDeploy ? "Posição aberta" : "Rebalance concluído"} | Fee: $${prev.feeAccumulatedUSD.toFixed(4)}`);
    await this.telegram.send(msg);
  }

  // ── Sincronizar estado on-chain ao iniciar ────────────────────────────────

  private async syncOnChainState(): Promise<void> {
    if (!this.keeper) return;

    try {
      const onChain = await this.keeper.getOnChainPosition();

      if (onChain.liquidity > 0n) {
        this.position = {
          lowerPrice:        TickMath.tickToPrice(onChain.tickLower),
          upperPrice:        TickMath.tickToPrice(onChain.tickUpper),
          centerPrice:       onChain.entryPriceUSD,
          entryPrice:        onChain.entryPriceUSD,
          liquidityUSD:      this.config.initialLiquidityUSD,
          feeAccumulatedUSD: 0,
          lastRebalanceTs:   onChain.lastRebalanceTs * 1000,
          tickLower:         onChain.tickLower,
          tickUpper:         onChain.tickUpper,
        };

        this.log.info(
          `🔄 Estado sincronizado | ${TickMath.describe(onChain.tickLower, onChain.tickUpper)} | ` +
          `rebalances anteriores: ${onChain.rebalanceCount}`
        );
      } else {
        this.log.info(`📭 Nenhuma posição ativa no contrato — aguardando primeiro deploy`);
      }
    } catch (e) {
      this.log.warn(`Não foi possível sincronizar estado on-chain: ${e}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  printReport(): void {
    this.metrics.printSummary();
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const bot = new LPManagerBot();

process.on("SIGINT", async () => {
  console.log("\n📊 Relatório final:");
  bot.printReport();
  process.exit(0);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("💥 Unhandled rejection:", reason);
  process.exit(1);
});

bot.run().catch(console.error);
