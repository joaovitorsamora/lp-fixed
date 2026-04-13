# LP Manager — Sistema Completo (Fases 1–4)

Sistema de gerenciamento automatizado de liquidez para Uniswap V3.
Arquitetura híbrida: inteligência off-chain + execução on-chain segura.

---

## Estrutura do projeto

```
lp-manager-complete/
├── lp-bot/          ← Bot off-chain (TypeScript) — toda a inteligência
└── lp-keeper/       ← Contrato on-chain (Solidity) — executor seguro
```

---

## Fluxo completo

```
[Mercado]
    │
    ▼
[lp-bot] GeckoTerminal / Binance / Cache
    │  ATR → regime → range dinâmico
    │  Tríade: range + desvio + cooldown + IL>fee
    │
    ├─ NÃO → ✋ Mantém posição (log: motivo)
    │
    └─ SIM → KeeperClient (viem)
                │  priceToTick() → alinhamento
                │  simulateContract() → catch errors
                │  writeContract() → tx on-chain
                ▼
           [lp-keeper] LPKeeper.sol
                │  onlyKeeper ✓
                │  cooldownPassed ✓
                │  notPaused ✓
                │  dailyLimitOk ✓
                │  slippage ✓
                └─ emit Rebalanced(...)
```

---

## Início rápido — tudo local

### Passo 1: compilar e deployar o contrato
```bash
cd lp-keeper
npm install
node scripts/compile.js       # gera artifacts/LPKeeper.json

# Terminal separado:
npm run node                  # sobe hardhat node em :8545

# Outro terminal:
npm run deploy                # deploya e salva deployment.json
```

### Passo 2: configurar e rodar o bot
```bash
cd lp-bot
npm install
cp .env.example .env
# Editar .env:
#   KEEPER_CONTRACT = endereço do deployment.json
#   DRY_RUN = true (começa simulando)

npm run dev:mock              # testar com dados sintéticos
npm run dev                   # rodar com dados reais + contrato
```

### Rodar testes do contrato
```bash
cd lp-keeper
# (hardhat node rodando em outro terminal)
npm test                      # 28 testes
```

---

## Configuração — `.env` do bot

| Variável | Descrição | Exemplo |
|---|---|---|
| `RPC_URL` | Endpoint RPC | `http://127.0.0.1:8545` |
| `CHAIN_ID` | ID da rede | `31337` (local) |
| `PRIVATE_KEY` | Chave do keeper | `0x59c6...` |
| `KEEPER_CONTRACT` | Endereço do contrato | `0xABC...` |
| `DRY_RUN` | Simular sem enviar tx | `true` |
| `LOG_LEVEL` | Verbosidade | `info` |
| `USE_MOCK` | Dados sintéticos | `false` |
| `MOCK_SCENARIO` | Cenário de teste | `slow_drift` |

---

## Resumo das fases

| Fase | O que foi construído |
|---|---|
| **1** | Loop principal, tríade de decisão, métricas |
| **2** | GeckoTerminal + Binance + cache + 6 cenários de mock |
| **3** | `LPKeeper.sol` com guards + 28 testes |
| **4** | `KeeperClient` (viem) + `TickMath` + sync on-chain |

---

## Próxima fase: Fase 5 — Multi-range

Dividir capital em N ranges simultâneos:

```typescript
// 50% no range central (±5%), 30% no médio (±10%), 20% no largo (±20%)
const ranges = MultiRangeStrategy.calculate(market, {
  capital: 10_000,
  distribution: [
    { weight: 0.5, widthMultiplier: 1.0 },
    { weight: 0.3, widthMultiplier: 2.0 },
    { weight: 0.2, widthMultiplier: 4.0 },
  ],
});
```

Benefícios: reduz risco de ficar fora do range, mantém fee mesmo em volatilidade.
