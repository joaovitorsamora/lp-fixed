/**
 * KeeperClient — Camada de integração com o contrato LPKeeper via viem
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hash,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat, mainnet, sepolia, arbitrum, arbitrumSepolia } from "viem/chains";
import { Logger } from "../utils/logger";

// ── ABI mínimo do LPKeeper ────────────────────────────────────────────────────

const KEEPER_ABI = [
  {
    name: "canRebalance",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "ok",     type: "bool"   },
      { name: "reason", type: "string" },
    ],
  },
  {
    name: "getPosition",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{
      name: "",
      type: "tuple",
      components: [
        { name: "tickLower",       type: "int24"   },
        { name: "tickUpper",       type: "int24"   },
        { name: "liquidity",       type: "uint128" },
        { name: "entryPrice",      type: "uint256" },
        { name: "feeAccumulated",  type: "uint256" },
        { name: "lastRebalanceTs", type: "uint256" },
        { name: "rebalanceCount",  type: "uint256" },
      ],
    }],
  },
  {
    name: "secondsUntilCooldownEnd",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "paused",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "rebalance",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{
      name: "params",
      type: "tuple",
      components: [
        { name: "newTickLower",   type: "int24"   },
        { name: "newTickUpper",   type: "int24"   },
        { name: "currentPrice",   type: "uint256" },
        { name: "minAmount0",     type: "uint256" },
        { name: "minAmount1",     type: "uint256" },
        { name: "liquidityDelta", type: "uint128" },
      ],
    }],
    outputs: [],
  },
  {
    name: "openPosition",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tickLower",  type: "int24"   },
      { name: "tickUpper",  type: "int24"   },
      { name: "entryPrice", type: "uint256" },
      { name: "liquidity",  type: "uint128" },
    ],
    outputs: [],
  },
  {
    name: "triggerCircuitBreaker",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "reason", type: "string" }],
    outputs: [],
  },
  {
    name: "Rebalanced",
    type: "event",
    inputs: [
      { name: "keeper",      type: "address", indexed: true  },
      { name: "oldTickLower",type: "int24",   indexed: false },
      { name: "oldTickUpper",type: "int24",   indexed: false },
      { name: "newTickLower",type: "int24",   indexed: false },
      { name: "newTickUpper",type: "int24",   indexed: false },
      { name: "currentPrice",type: "uint256", indexed: false },
      { name: "timestamp",   type: "uint256", indexed: false },
    ],
  },
] as const;

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface OnChainPosition {
  tickLower:       number;
  tickUpper:       number;
  liquidity:       bigint;
  entryPriceUSD:   number;
  feeAccumulated:  bigint;
  lastRebalanceTs: number;
  rebalanceCount:  number;
}

export interface KeeperRebalanceInput {
  newTickLower:    number;
  newTickUpper:    number;
  currentPriceUSD: number;
  slippageBps:     number;
  liquidityDelta?: bigint;
}

export interface KeeperConfig {
  rpcUrl:          string;
  privateKey:      `0x${string}`;
  contractAddress: Address;
  chainId:         number;
  dryRun:          boolean;
}

// ── KeeperClient ──────────────────────────────────────────────────────────────

export class KeeperClient {
  private publicClient:    PublicClient;
  private walletClient:    WalletClient;
  private contractAddress: Address;
  private dryRun:          boolean;
  private log = new Logger("KeeperClient");

  constructor(cfg: KeeperConfig) {
    this.contractAddress = cfg.contractAddress;
    this.dryRun          = cfg.dryRun;

    // Suporte a todas as redes relevantes
    const chain =
      cfg.chainId === 1       ? mainnet :
      cfg.chainId === 11155111? sepolia :
      cfg.chainId === 42161   ? arbitrum :
      cfg.chainId === 421614  ? arbitrumSepolia :
      hardhat; // 31337 = local

    const transport = http(cfg.rpcUrl);
    this.publicClient = createPublicClient({ chain, transport });

    const account = privateKeyToAccount(cfg.privateKey);
    this.walletClient = createWalletClient({ account, chain, transport });

    this.log.info(`Inicializado | chain: ${chain.name} | dryRun: ${cfg.dryRun}`);
  }

  // ── Leitura ───────────────────────────────────────────────────────────────

  async canRebalance(): Promise<{ ok: boolean; reason: string }> {
    const [ok, reason] = await this.publicClient.readContract({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "canRebalance",
    }) as [boolean, string];
    return { ok, reason };
  }

  async getOnChainPosition(): Promise<OnChainPosition> {
    const pos = await this.publicClient.readContract({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "getPosition",
    }) as unknown as {
      tickLower: bigint; tickUpper: bigint; liquidity: bigint;
      entryPrice: bigint; feeAccumulated: bigint;
      lastRebalanceTs: bigint; rebalanceCount: bigint;
    };

    return {
      tickLower:       Number(pos.tickLower),
      tickUpper:       Number(pos.tickUpper),
      liquidity:       pos.liquidity,
      entryPriceUSD:   parseFloat(formatUnits(pos.entryPrice, 18)),
      feeAccumulated:  pos.feeAccumulated,
      lastRebalanceTs: Number(pos.lastRebalanceTs),
      rebalanceCount:  Number(pos.rebalanceCount),
    };
  }

  async isPaused(): Promise<boolean> {
    return this.publicClient.readContract({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "paused",
    }) as Promise<boolean>;
  }

  async secondsUntilCooldown(): Promise<number> {
    const s = await this.publicClient.readContract({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "secondsUntilCooldownEnd",
    }) as bigint;
    return Number(s);
  }

  // ── Escrita ───────────────────────────────────────────────────────────────

  async rebalance(input: KeeperRebalanceInput): Promise<Hash | null> {
    const params = this.buildRebalanceParams(input);

    this.log.info(
      `${this.dryRun ? "[DRY RUN] " : ""}rebalance() | ` +
      `ticks: [${params.newTickLower}, ${params.newTickUpper}] | ` +
      `preço: $${input.currentPriceUSD.toFixed(4)}`
    );

    if (this.dryRun) {
      await this.publicClient.simulateContract({
        address:      this.contractAddress,
        abi:          KEEPER_ABI,
        functionName: "rebalance",
        args:         [params],
        account:      this.walletClient.account,
      });
      this.log.info(`[DRY RUN] Simulação OK — tx não enviada`);
      return null;
    }

    const gasEstimate = await this.publicClient.estimateContractGas({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "rebalance",
      args:         [params],
      account:      this.walletClient.account,
    });
    this.log.debug(`Gas estimado: ${gasEstimate.toLocaleString()}`);

    const { request } = await this.publicClient.simulateContract({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "rebalance",
      args:         [params],
      account:      this.walletClient.account,
    });

    const hash = await this.walletClient.writeContract(request);
    this.log.info(`Tx enviada: ${hash}`);

    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    this.log.info(`Confirmada | bloco: ${receipt.blockNumber} | gas: ${receipt.gasUsed.toLocaleString()}`);
    return hash;
  }

  async openPosition(
    tickLower:       number,
    tickUpper:       number,
    currentPriceUSD: number,
    liquidityUnits:  bigint = 1000n
  ): Promise<Hash | null> {
    const entryPrice = parseUnits(currentPriceUSD.toFixed(18), 18);

    this.log.info(
      `${this.dryRun ? "[DRY RUN] " : ""}openPosition() | ` +
      `ticks: [${tickLower}, ${tickUpper}] | preço: $${currentPriceUSD.toFixed(4)}`
    );

    if (this.dryRun) {
      await this.publicClient.simulateContract({
        address:      this.contractAddress,
        abi:          KEEPER_ABI,
        functionName: "openPosition",
        args:         [tickLower, tickUpper, entryPrice, liquidityUnits],
        account:      this.walletClient.account,
      });
      this.log.info(`[DRY RUN] openPosition simulado OK`);
      return null;
    }

    const { request } = await this.publicClient.simulateContract({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "openPosition",
      args:         [tickLower, tickUpper, entryPrice, liquidityUnits],
      account:      this.walletClient.account,
    });

    const hash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash });
    this.log.info(`openPosition confirmado: ${hash}`);
    return hash;
  }

  async triggerCircuitBreaker(reason: string): Promise<Hash | null> {
    this.log.warn(`⚡ Circuit breaker on-chain | ${reason}`);

    if (this.dryRun) {
      this.log.warn(`[DRY RUN] Circuit breaker não enviado`);
      return null;
    }

    const { request } = await this.publicClient.simulateContract({
      address:      this.contractAddress,
      abi:          KEEPER_ABI,
      functionName: "triggerCircuitBreaker",
      args:         [reason],
      account:      this.walletClient.account,
    });

    const hash = await this.walletClient.writeContract(request);
    await this.publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }

  // ── Internos ──────────────────────────────────────────────────────────────

  private buildRebalanceParams(input: KeeperRebalanceInput) {
    const currentPrice   = parseUnits(input.currentPriceUSD.toFixed(18), 18);
    const slippageFactor = BigInt(10000 - input.slippageBps);
    const minAmount0     = (currentPrice * slippageFactor) / 10000n;

    return {
      newTickLower:   input.newTickLower,
      newTickUpper:   input.newTickUpper,
      currentPrice,
      minAmount0,
      minAmount1:     0n,
      liquidityDelta: input.liquidityDelta ?? 0n,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createKeeperClientFromEnv(): KeeperClient | null {
  const rpcUrl   = process.env.RPC_URL;
  const pk       = process.env.PRIVATE_KEY;
  const contract = process.env.KEEPER_CONTRACT;
  const chainId  = parseInt(process.env.CHAIN_ID ?? "31337");
  const dryRun   = process.env.DRY_RUN !== "false";

  if (!rpcUrl || !pk || !contract ||
      contract === "0x0000000000000000000000000000000000000000") {
    return null;
  }

  return new KeeperClient({
    rpcUrl,
    privateKey:      pk as `0x${string}`,
    contractAddress: contract as Address,
    chainId,
    dryRun,
  });
}
