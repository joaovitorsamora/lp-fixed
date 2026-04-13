# CHANGELOG — v2.1.0 (correções para produção)

## 🔴 Bugs críticos corrigidos

### 1. Token do Telegram exposto no `.env.example`
- **Problema:** `TELEGRAM_TOKEN=AAEBUy7-Yg8hwx_poggrC_t8AmUWsy1JLy0` — token real em arquivo que vai para o repositório
- **Correção:** Campo deixado vazio (`TELEGRAM_TOKEN=`) com instruções de como configurar

### 2. `KEEPER_CONTRACT` apontava para uma wallet, não um contrato
- **Problema:** `KEEPER_CONTRACT=0x70997970C51812dc3A010C7d01b50e0d17dc79C8` — esse é o endereço da conta #1 do hardhat, não do contrato deployado
- **Correção:** Valor correto `0x0000000000000000000000000000000000000000` com aviso claro no comentário. `createKeeperClientFromEnv()` agora rejeita o endereço zero

### 3. Execução on-chain ausente no `index.ts`
- **Problema:** O bloco `if (this.keeper)` que chama `keeper.rebalance()` e `keeper.openPosition()` havia sido removido na versão do usuário — o bot nunca chamava o contrato mesmo com keeper configurado
- **Correção:** Bloco restaurado com tratamento correto de erro (não atualiza estado local se tx falhou)

### 4. `gasCostUSD` ignorado nas métricas
- **Problema:** `metrics.recordRebalance()` hardcoded `+= 8` USD ignorando o `gasCostUSD` da config (que é `0.30` para Arbitrum)
- **Correção:** `gasCostUSD` passado explicitamente no `recordRebalance()` e `MetricsTracker` aceita o valor correto

### 5. `consecutiveErrors` calculado incorretamente
- **Problema:** Getter retornava `this.errors` (total acumulado), nunca resetava — nome `consecutiveErrors` era enganoso
- **Correção:** Campo separado `_consecutiveErrors` que reseta após um tick bem-sucedido

### 6. `fetchPoolData` usava `(this as any).mock`
- **Problema:** Acesso hacky ao campo privado `mock` via `(this as any)` — TypeScript bypass + código frágil
- **Correção:** `DataFetcherWithMock` agora sobrescreve `fetchPoolData()` diretamente de forma tipada

### 7. Import não utilizado em `keeper-client.ts`
- **Problema:** `getContract` importado do viem mas nunca usado
- **Correção:** Import removido

## 🟡 Melhorias de produção

### 8. `TelegramNotifier` sem retry nem timeout
- **Antes:** Uma falha de rede derrubava silenciosamente a notificação sem retry
- **Depois:** 2 tentativas com timeout de 5s cada; falhas logadas como `warn`, não `error`; validação correta do `TELEGRAM_CHAT_ID` (ignorava valor literal `"TELEGRAM_CHAT_ID"`)

### 9. Circuit breaker off-chain não propagado ao contrato
- **Antes:** Bot detectava volatilidade extrema mas não chamava `triggerCircuitBreaker()` on-chain
- **Depois:** Quando circuit breaker off-chain ativa, o bot propaga para o contrato (se keeper disponível e contrato não pausado)

### 10. Suporte a Arbitrum Sepolia no `keeper-client.ts`
- **Antes:** Somente mainnet, sepolia e hardhat suportados — Arbitrum (chainId 42161) caía no `hardhat` por padrão
- **Depois:** `arbitrum` (42161) e `arbitrumSepolia` (421614) adicionados explicitamente

### 11. `uncaughtException` e `unhandledRejection` sem handler
- **Antes:** Processo podia morrer silenciosamente em produção
- **Depois:** Handlers adicionados com log + `process.exit(1)`

### 12. Precisão dos valores de fee no log
- **Antes:** `.toFixed(2)` — perdia precisão para tokens baratos como ARB ($0.60)
- **Depois:** `.toFixed(4)` — mostra valores como `$0.0023` corretamente

### 13. `cross-env` versão corrigida
- **Antes:** `"cross-env": "^10.1.0"` — versão inexistente (última é 7.x)
- **Depois:** `"cross-env": "^7.0.3"` — versão estável correta
