/**
 * Compile LPKeeper.sol usando solc local (sem download de compilador)
 * Rodar: node scripts/compile.js
 */

const solc = require("solc");
const fs   = require("fs");
const path = require("path");

const contractPath = path.join(__dirname, "../contracts/LPKeeper.sol");
const source = fs.readFileSync(contractPath, "utf8");

const input = {
  language: "Solidity",
  sources: { "LPKeeper.sol": { content: source } },
  settings: {
    outputSelection: { "*": { "*": ["abi", "evm.bytecode", "evm.deployedBytecode"] } },
    optimizer: { enabled: true, runs: 200 },
  },
};

console.log("🔨 Compilando LPKeeper.sol...");
const output = JSON.parse(solc.compile(JSON.stringify(input)));

let hasError = false;
if (output.errors) {
  for (const e of output.errors) {
    if (e.severity === "error") {
      console.error("❌ Erro:", e.formattedMessage);
      hasError = true;
    } else {
      console.warn("⚠️  Aviso:", e.message);
    }
  }
}

if (hasError) process.exit(1);

const contract = output.contracts["LPKeeper.sol"]["LPKeeper"];
const artifact = {
  contractName: "LPKeeper",
  abi: contract.abi,
  bytecode: "0x" + contract.evm.bytecode.object,
  deployedBytecode: "0x" + contract.evm.deployedBytecode.object,
};

fs.mkdirSync(path.join(__dirname, "../artifacts"), { recursive: true });
fs.writeFileSync(
  path.join(__dirname, "../artifacts/LPKeeper.json"),
  JSON.stringify(artifact, null, 2)
);

const bytesize = artifact.deployedBytecode.length / 2 - 1;
console.log(`✅ Compilado com sucesso!`);
console.log(`   Bytecode size: ${bytesize} bytes`);
console.log(`   Funções: ${contract.abi.filter(x => x.type === "function").map(x => x.name).join(", ")}`);
console.log(`   Eventos: ${contract.abi.filter(x => x.type === "event").map(x => x.name).join(", ")}`);
console.log(`   Artifact salvo em: artifacts/LPKeeper.json`);
