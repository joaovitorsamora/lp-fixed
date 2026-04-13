# LP Keeper — Contrato Solidity (Fase 3)

Executor on-chain para o LP Manager Bot. Toda a inteligência fica no bot off-chain (Fase 2).
Este contrato é **burro e seguro** — só executa quando o bot manda.

## Arquitetura

```
Bot OFF-CHAIN (lp-bot/)          Contrato ON-CHAIN (lp-keeper/)
────────────────────────         ──────────────────────────────
Analisa mercado                  LPKeeper.sol
Decide se rebalanceia       →    rebalance(params)
Calcula range ideal              openPosition(ticks, price, liq)
Checa cooldown / IL / fee        triggerCircuitBreaker(reason)
                                 emergencyWithdraw(to)
```

## Como rodar localmente

### 1. Instalar dependências
```bash
npm install
```

### 2. Compilar o contrato
```bash
npm run compile
# Gera: artifacts/LPKeeper.json (ABI + bytecode)
```

### 3. Subir o node local (terminal separado)
```bash
npm run node
# Sobe hardhat node em http://127.0.0.1:8545
# Mostra 20 contas de teste com ETH
```

### 4. Rodar os testes (outro terminal)
```bash
npm test
# 28 testes cobrindo: deploy, openPosition, rebalance,
# cooldown, circuit breaker, emergency withdraw, admin
```

### 5. Deploy no node local
```bash
npm run deploy
# Deploya o contrato e salva deployment.json
```

## Contrato: LPKeeper.sol

### Guards de segurança
| Guard | Proteção |
|---|---|
| `onlyKeeper` | Só o bot autorizado pode rebalancear |
| `onlyOwner` | Só o dono pode mudar configurações |
| `notPaused` | Circuit breaker bloqueia tudo |
| `cooldownPassed` | Mínimo 30min entre rebalances |
| `dailyLimitOk` | Máximo 10 rebalances por dia |

### Funções principais
```solidity
// Chamadas pelo BOT (keeper)
rebalance(RebalanceParams)        // rebalancear posição
openPosition(tl, tu, price, liq) // abrir posição inicial
triggerCircuitBreaker(reason)     // pausar em emergência

// Chamadas pelo OWNER
resetCircuitBreaker()             // despausar
emergencyWithdraw(to)             // sacar tudo
setKeeper(address)                // trocar bot autorizado
setMaxSlippage(bps)               // ajustar slippage máximo
setCooldown(seconds)              // ajustar cooldown

// Views (qualquer um)
canRebalance()                    // (bool ok, string reason)
getPosition()                     // struct Position completa
secondsUntilCooldownEnd()         // segundos restantes
```

### Eventos emitidos
```
Rebalanced(keeper, oldTicks, newTicks, price, timestamp)
PositionOpened(tickLower, tickUpper, entryPrice, liquidity)
CircuitBreakerTriggered(by, reason)
CircuitBreakerReset(by)
EmergencyWithdraw(to, amount0, amount1)
KeeperUpdated(oldKeeper, newKeeper)
```

## Próxima fase: Fase 4

Integrar o bot off-chain (lp-bot/) com este contrato usando **viem**:

```typescript
// No bot (lp-bot/src/index.ts):
// Em vez de simular o rebalance:
const hash = await walletClient.writeContract({
  address: KEEPER_ADDRESS,
  abi: LPKeeperABI,
  functionName: "rebalance",
  args: [params],
});
```

## Notas para produção

- Trocar `simulatedBalance0/1` por tokens ERC-20 reais
- Integrar `INonfungiblePositionManager` da Uniswap V3
- Adicionar validação Chainlink para anti-manipulação de preço
- Deploy via Hardhat Ignition em Sepolia antes da mainnet
