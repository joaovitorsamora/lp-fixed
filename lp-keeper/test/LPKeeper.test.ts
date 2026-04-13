/**
 * Testes do LPKeeper — ambiente local
 * Rodar: npm test  (requer: npm run node em outro terminal)
 */

import { ethers, Contract, ContractFactory, JsonRpcProvider, Wallet } from "ethers";
import * as fs from "fs";
import * as path from "path";

// ── Mini framework de testes ──────────────────────────────────────────────────

let passed = 0, failed = 0;

async function it(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e: unknown) {
    console.log(`  ❌  ${name}`);
    console.log(`       → ${e instanceof Error ? e.message : String(e)}`);
    failed++;
  }
}

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

async function expectRevert(promise: Promise<unknown>, snippet?: string) {
  try {
    await promise;
    throw new Error("Expected revert but tx succeeded");
  } catch (e: unknown) {
    if (e instanceof Error && e.message === "Expected revert but tx succeeded") throw e;
    if (snippet) {
      const s = String(e);
      if (!s.includes(snippet)) throw new Error(`Expected "${snippet}" in error, got: ${s}`);
    }
  }
}

async function mineBlocks(provider: JsonRpcProvider, seconds: number) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

// ── Tipagem do contrato ───────────────────────────────────────────────────────

type LPKeeperContract = Contract & {
  owner(): Promise<string>;
  keeper(): Promise<string>;
  paused(): Promise<boolean>;
  simulatedBalance0(): Promise<bigint>;
  simulatedBalance1(): Promise<bigint>;
  maxSlippageBps(): Promise<bigint>;
  cooldownSeconds(): Promise<bigint>;
  dailyRebalanceCount(): Promise<bigint>;
  getPosition(): Promise<{
    tickLower: bigint; tickUpper: bigint; liquidity: bigint;
    entryPrice: bigint; feeAccumulated: bigint;
    lastRebalanceTs: bigint; rebalanceCount: bigint;
  }>;
  canRebalance(): Promise<[boolean, string]>;
  secondsUntilCooldownEnd(): Promise<bigint>;
  openPosition(tl: number, tu: number, price: bigint, liq: bigint): Promise<{ wait(): Promise<unknown> }>;
  rebalance(p: RebalanceParams): Promise<{ wait(): Promise<unknown> }>;
  triggerCircuitBreaker(reason: string): Promise<{ wait(): Promise<unknown> }>;
  resetCircuitBreaker(): Promise<{ wait(): Promise<unknown> }>;
  emergencyWithdraw(to: string): Promise<{ wait(): Promise<unknown> }>;
  setKeeper(addr: string): Promise<{ wait(): Promise<unknown> }>;
  setMaxSlippage(bps: number): Promise<{ wait(): Promise<unknown> }>;
  setCooldown(s: number): Promise<{ wait(): Promise<unknown> }>;
};

interface RebalanceParams {
  newTickLower: number;
  newTickUpper: number;
  currentPrice: bigint;
  minAmount0: bigint;
  minAmount1: bigint;
  liquidityDelta: bigint;
}

function mkParams(o: Partial<RebalanceParams> = {}): RebalanceParams {
  return {
    newTickLower:   o.newTickLower   ?? -1000,
    newTickUpper:   o.newTickUpper   ?? 1000,
    currentPrice:   o.currentPrice   ?? ethers.parseUnits("3200", 18),
    minAmount0:     o.minAmount0     ?? 0n,
    minAmount1:     o.minAmount1     ?? 0n,
    liquidityDelta: o.liquidityDelta ?? 0n,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────────────

async function setup() {
  const art = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../artifacts/LPKeeper.json"), "utf8")
  );

  const provider = new JsonRpcProvider("http://127.0.0.1:8545");

  const owner  = new Wallet("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", provider);
  const keeper = new Wallet("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", provider);
  const other  = new Wallet("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", provider);

  const factory = new ContractFactory(art.abi, art.bytecode, owner);
  const deployed = await factory.deploy(keeper.address) as LPKeeperContract;
  await deployed.waitForDeployment();

  const at = (signer: Wallet) => deployed.connect(signer) as LPKeeperContract;

  return { c: deployed, owner, keeper, other, provider, at };
}

// ── Suite de testes ───────────────────────────────────────────────────────────

async function main() {
  console.log("\n🧪 LPKeeper — Test Suite\n");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  let ctx: Awaited<ReturnType<typeof setup>>;
  try {
    ctx = await setup();
    console.log(`  📦 Deploy: ${await ctx.c.getAddress()}\n`);
  } catch {
    console.error("❌ Falha no setup. Hardhat node rodando? → npm run node");
    process.exit(1);
  }

  const { c, owner, keeper, other, provider, at } = ctx;

  // ── Deploy ──────────────────────────────────────────────────────────────────
  console.log("📋 Deploy & Estado Inicial");

  await it("owner correto", async () => {
    assert((await c.owner()) === owner.address, "owner errado");
  });

  await it("keeper correto", async () => {
    assert((await c.keeper()) === keeper.address, "keeper errado");
  });

  await it("começa não pausado", async () => {
    assert(!(await c.paused()), "deveria estar não pausado");
  });

  await it("saldo simulado inicializado", async () => {
    assert((await c.simulatedBalance0()) > 0n, "balance0 zerado");
    assert((await c.simulatedBalance1()) > 0n, "balance1 zerado");
  });

  await it("defaults de segurança corretos", async () => {
    assert((await c.maxSlippageBps()) === 50n, "slippage padrão errado");
    assert((await c.cooldownSeconds()) === 1800n, "cooldown padrão errado");
  });

  // ── openPosition ────────────────────────────────────────────────────────────
  console.log("\n📋 openPosition");

  await it("keeper abre posição inicial", async () => {
    const tx = await at(keeper).openPosition(-1000, 1000, ethers.parseUnits("3200", 18), 1000n);
    await tx.wait();
    const pos = await c.getPosition();
    assert(Number(pos.tickLower) === -1000, "tickLower errado");
    assert(Number(pos.tickUpper) === 1000, "tickUpper errado");
    assert(pos.liquidity > 0n, "liquidity zerada");
  });

  await it("não abre posição duplicada", async () => {
    await expectRevert(
      at(keeper).openPosition(-2000, 2000, ethers.parseUnits("3200", 18), 1000n),
      "position already open"
    );
  });

  await it("owner não pode abrir posição (só keeper)", async () => {
    await expectRevert(
      at(owner).openPosition(-500, 500, ethers.parseUnits("3200", 18), 500n),
      "not keeper"
    );
  });

  await it("ticks inválidos rejeitados (lower >= upper)", async () => {
    // precisamos de uma instância fresca para testar isso — mas posição já aberta
    // testamos via rebalance com ticks inválidos em vez disso
    await mineBlocks(provider, 1801);
    await expectRevert(
      at(keeper).rebalance(mkParams({ newTickLower: 500, newTickUpper: -500 }))
    );
  });

  // ── rebalance ───────────────────────────────────────────────────────────────
  console.log("\n📋 rebalance");

  await it("keeper rebalanceia após cooldown", async () => {
    await mineBlocks(provider, 1801);
    const tx = await at(keeper).rebalance(mkParams({ newTickLower: -1200, newTickUpper: 1200 }));
    await tx.wait();
    const pos = await c.getPosition();
    assert(Number(pos.tickLower) === -1200, "tickLower não atualizado");
    assert(Number(pos.tickUpper) === 1200, "tickUpper não atualizado");
  });

  await it("rebalanceCount incrementa", async () => {
    const pos = await c.getPosition();
    assert(Number(pos.rebalanceCount) >= 1, "rebalanceCount não incrementou");
  });

  await it("non-keeper não pode rebalancear", async () => {
    await expectRevert(at(other).rebalance(mkParams()), "not keeper");
  });

  await it("tick não alinhado (spacing 10) é rejeitado", async () => {
    await expectRevert(
      at(keeper).rebalance(mkParams({ newTickLower: -1001, newTickUpper: 1000 })),
      "tick not aligned"
    );
  });

  await it("preço zero é rejeitado", async () => {
    await expectRevert(
      at(keeper).rebalance(mkParams({ currentPrice: 0n })),
      "invalid price"
    );
  });

  // ── Cooldown ─────────────────────────────────────────────────────────────────
  console.log("\n📋 Cooldown");

  await it("revert dentro do cooldown", async () => {
    // sem avançar tempo — cooldown ativo
    await expectRevert(
      at(keeper).rebalance(mkParams({ newTickLower: -800, newTickUpper: 800 })),
      "cooldown not passed"
    );
  });

  await it("canRebalance() retorna false no cooldown", async () => {
    const [ok, reason] = await c.canRebalance();
    assert(!ok, "deveria retornar false");
    assert(reason.includes("cooldown"), `reason: "${reason}"`);
  });

  await it("secondsUntilCooldownEnd() > 0 no cooldown", async () => {
    const s = await c.secondsUntilCooldownEnd();
    assert(s > 0n, "deveria ser > 0");
  });

  await it("canRebalance() retorna true após cooldown", async () => {
    await mineBlocks(provider, 1801);
    const [ok] = await c.canRebalance();
    assert(ok, "deveria retornar true");
  });

  // ── Circuit Breaker ──────────────────────────────────────────────────────────
  console.log("\n📋 Circuit Breaker");

  await it("owner ativa circuit breaker", async () => {
    const tx = await at(owner).triggerCircuitBreaker("teste: alta volatilidade");
    await tx.wait();
    assert(await c.paused(), "deveria estar pausado");
  });

  await it("rebalance bloqueado quando pausado", async () => {
    await expectRevert(at(keeper).rebalance(mkParams()), "circuit breaker active");
  });

  await it("keeper também pode ativar circuit breaker", async () => {
    await at(owner).resetCircuitBreaker().then(tx => tx.wait());
    assert(!(await c.paused()), "deveria estar despausado após reset");
    await at(keeper).triggerCircuitBreaker("keeper: anomalia detectada").then(tx => tx.wait());
    assert(await c.paused(), "keeper deveria conseguir pausar");
  });

  await it("owner reseta circuit breaker", async () => {
    await at(owner).resetCircuitBreaker().then(tx => tx.wait());
    assert(!(await c.paused()), "deveria estar despausado");
  });

  await it("non-owner não pode resetar", async () => {
    await at(owner).triggerCircuitBreaker("setup").then(tx => tx.wait());
    await expectRevert(at(other).resetCircuitBreaker(), "not owner");
    await at(owner).resetCircuitBreaker().then(tx => tx.wait()); // cleanup
  });

  await it("non-authorized não pode ativar circuit breaker", async () => {
    await expectRevert(at(other).triggerCircuitBreaker("hack"), "not authorized");
  });

  // ── Emergency Withdraw ───────────────────────────────────────────────────────
  console.log("\n📋 Emergency Withdraw");

  await it("owner faz emergency withdraw — zera balances", async () => {
    await at(owner).emergencyWithdraw(owner.address).then(tx => tx.wait());
    assert((await c.simulatedBalance0()) === 0n, "balance0 deveria ser 0");
    assert((await c.simulatedBalance1()) === 0n, "balance1 deveria ser 0");
  });

  await it("emergencyWithdraw pausa automaticamente", async () => {
    assert(await c.paused(), "deveria pausar após emergency");
  });

  await it("non-owner não pode fazer emergency withdraw", async () => {
    await expectRevert(at(other).emergencyWithdraw(other.address), "not owner");
  });

  // ── Admin ────────────────────────────────────────────────────────────────────
  console.log("\n📋 Admin / Configuração");

  await it("owner atualiza keeper", async () => {
    await at(owner).setKeeper(other.address).then(tx => tx.wait());
    assert((await c.keeper()) === other.address, "keeper não atualizado");
  });

  await it("setMaxSlippage revert acima de 500bps", async () => {
    await expectRevert(at(owner).setMaxSlippage(501), "slippage too high");
  });

  await it("setMaxSlippage aceita valor válido", async () => {
    await at(owner).setMaxSlippage(100).then(tx => tx.wait());
    assert((await c.maxSlippageBps()) === 100n, "slippage não atualizado");
  });

  await it("setCooldown revert abaixo de 300s", async () => {
    await expectRevert(at(owner).setCooldown(299), "cooldown too short");
  });

  await it("setCooldown aceita valor válido", async () => {
    await at(owner).setCooldown(600).then(tx => tx.wait());
    assert((await c.cooldownSeconds()) === 600n, "cooldown não atualizado");
  });

  await it("non-owner não pode setar keeper", async () => {
    await expectRevert(at(other).setKeeper(other.address), "not owner");
  });

  // ── Resultado ─────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`\n📊 ${total} testes | ✅ ${passed} passaram | ❌ ${failed} falharam\n`);

  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
