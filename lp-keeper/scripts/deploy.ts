/**
 * Deploy script — LPKeeper
 *
 * Uso:
 *   npx ts-node scripts/deploy.ts                        (localhost)
 *   KEEPER=0x... npx ts-node scripts/deploy.ts           (keeper personalizado)
 */

import { ethers } from "ethers";
import * as fs from "fs";
import * as path from "path";

async function main() {
  console.log("\n🚀 Deploy LPKeeper\n");

  const artifact = JSON.parse(
    fs.readFileSync(path.join(__dirname, "../artifacts/LPKeeper.json"), "utf8")
  );

  // Provider local (hardhat node)
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

  // Conta deployer (primeira conta do hardhat node)
  const deployer = new ethers.Wallet(
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
    provider
  );

  // Keeper — segunda conta do hardhat node, ou env KEEPER
  const keeperAddress = process.env.KEEPER ??
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

  console.log(`  Deployer: ${deployer.address}`);
  console.log(`  Keeper:   ${keeperAddress}`);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
  const contract = await factory.deploy(keeperAddress);
  await contract.waitForDeployment();

  const address = await contract.getAddress();
  console.log(`\n  ✅ LPKeeper deployado em: ${address}`);

  // Salvar endereço para uso do bot
  const deployment = {
    network: "localhost",
    address,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    keeper: keeperAddress,
  };

  fs.writeFileSync(
    path.join(__dirname, "../deployment.json"),
    JSON.stringify(deployment, null, 2)
  );

  console.log(`  📄 deployment.json salvo\n`);

  // Verificar estado inicial
  const pos = await (contract as any).getPosition();
  const paused = await (contract as any).paused();
  console.log(`  Estado inicial:`);
  console.log(`    paused: ${paused}`);
  console.log(`    liquidity: ${pos.liquidity}`);
  console.log(`    rebalanceCount: ${pos.rebalanceCount}`);
}

main().catch((e) => {
  console.error("Deploy falhou:", e.message);
  process.exit(1);
});
