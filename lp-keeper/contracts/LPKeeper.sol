// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title LPKeeper — Contrato Keeper para LP Manager
 * @notice Versão de TESTE — sem dependências externas reais (Uniswap, Chainlink)
 *         Toda a inteligência fica no bot off-chain.
 *         Este contrato é apenas o executor seguro.
 *
 * @dev Em produção: trocar MockPositionManager por INonfungiblePositionManager real
 *
 * Responsabilidades:
 *   ✅ Registrar posição atual (range, liquidity, entry price)
 *   ✅ Executar rebalanceamento (chamado pelo bot keeper)
 *   ✅ Guards de segurança (slippage, cooldown, paused)
 *   ✅ Emergency withdraw
 *   ✅ Circuit breaker manual
 *   ✅ Emitir eventos para monitoramento
 */
contract LPKeeper {

    // ─────────────────────────────────────────────────────────────────────────
    // Tipos e estado
    // ─────────────────────────────────────────────────────────────────────────

    struct Position {
        int24  tickLower;        // tick inferior do range
        int24  tickUpper;        // tick superior do range
        uint128 liquidity;       // liquidez atual na posição
        uint256 entryPrice;      // preço de entrada (18 decimais)
        uint256 feeAccumulated;  // fee acumulada em wei (token0)
        uint256 lastRebalanceTs; // timestamp do último rebalance
        uint256 rebalanceCount;  // total de rebalances executados
    }

    struct RebalanceParams {
        int24   newTickLower;    // novo tick inferior
        int24   newTickUpper;    // novo tick superior
        uint256 currentPrice;   // preço atual (18 decimais) — do bot
        uint256 minAmount0;     // proteção anti-slippage token0
        uint256 minAmount1;     // proteção anti-slippage token1
        uint128 liquidityDelta; // liquidez a adicionar (0 = manter tudo)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Armazenamento
    // ─────────────────────────────────────────────────────────────────────────

    address public owner;
    address public keeper;        // bot off-chain autorizado a chamar rebalance
    bool    public paused;        // circuit breaker manual

    Position public position;

    // Limites de segurança configuráveis pelo owner
    uint256 public maxSlippageBps = 50;      // 0.5% máximo de slippage
    uint256 public cooldownSeconds = 1800;   // 30 min entre rebalances
    uint256 public maxRebalancesPerDay = 10; // anti-spam

    // Contador diário de rebalances
    uint256 public dailyRebalanceCount;
    uint256 public dailyRebalanceResetTs;

    // Registro de saldo simulado (em teste — sem tokens reais)
    uint256 public simulatedBalance0; // token0 (ex: USDC)
    uint256 public simulatedBalance1; // token1 (ex: WETH)

    // ─────────────────────────────────────────────────────────────────────────
    // Eventos
    // ─────────────────────────────────────────────────────────────────────────

    event Rebalanced(
        address indexed keeper,
        int24 oldTickLower,
        int24 oldTickUpper,
        int24 newTickLower,
        int24 newTickUpper,
        uint256 currentPrice,
        uint256 timestamp
    );

    event PositionOpened(
        int24 tickLower,
        int24 tickUpper,
        uint256 entryPrice,
        uint128 liquidity
    );

    event CircuitBreakerTriggered(address indexed by, string reason);
    event CircuitBreakerReset(address indexed by);
    event KeeperUpdated(address indexed oldKeeper, address indexed newKeeper);
    event EmergencyWithdraw(address indexed to, uint256 amount0, uint256 amount1);
    event SlippageGuardFailed(uint256 expectedMin, uint256 actual);

    // ─────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────

    modifier onlyOwner() {
        require(msg.sender == owner, "LPKeeper: not owner");
        _;
    }

    modifier onlyKeeper() {
        require(msg.sender == keeper, "LPKeeper: not keeper");
        _;
    }

    modifier notPaused() {
        require(!paused, "LPKeeper: circuit breaker active");
        _;
    }

    modifier cooldownPassed() {
        require(
            block.timestamp >= position.lastRebalanceTs + cooldownSeconds,
            "LPKeeper: cooldown not passed"
        );
        _;
    }

    modifier dailyLimitOk() {
        // Reset contador se passou 24h
        if (block.timestamp >= dailyRebalanceResetTs + 1 days) {
            dailyRebalanceCount = 0;
            dailyRebalanceResetTs = block.timestamp;
        }
        require(
            dailyRebalanceCount < maxRebalancesPerDay,
            "LPKeeper: daily rebalance limit reached"
        );
        _;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Constructor
    // ─────────────────────────────────────────────────────────────────────────

    constructor(address _keeper) {
        owner  = msg.sender;
        keeper = _keeper;
        dailyRebalanceResetTs = block.timestamp;

        // Inicializar com saldo simulado para testes
        simulatedBalance0 = 5_000 * 1e6;   // 5000 USDC (6 decimais)
        simulatedBalance1 = 2 * 1e18;       // 2 WETH (18 decimais)
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Função principal: rebalancear
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Executa rebalanceamento da posição LP
     * @dev Chamado exclusivamente pelo bot keeper off-chain
     *      Toda decisão de QUANDO agir é feita no bot — aqui só validamos e executamos
     */
    function rebalance(RebalanceParams calldata params)
        external
        onlyKeeper
        notPaused
        cooldownPassed
        dailyLimitOk
    {
        // ── Validação de ticks ──────────────────────────────────────────────
        require(params.newTickLower < params.newTickUpper, "LPKeeper: invalid tick range");
        require(params.newTickLower % 10 == 0, "LPKeeper: tick not aligned (spacing 10)");
        require(params.newTickUpper % 10 == 0, "LPKeeper: tick not aligned (spacing 10)");

        // ── Validação de preço (anti-manipulação básica) ────────────────────
        require(params.currentPrice > 0, "LPKeeper: invalid price");

        // ── Validação de slippage ───────────────────────────────────────────
        // Em produção: calcular amounts esperados e comparar com minAmount0/1
        // Aqui (teste): apenas verificar que os mínimos são razoáveis
        _validateSlippage(params);

        // ── Salvar estado anterior para evento ──────────────────────────────
        int24 oldTickLower = position.tickLower;
        int24 oldTickUpper = position.tickUpper;

        // ── Atualizar posição ───────────────────────────────────────────────
        // Em produção: aqui chamar INonfungiblePositionManager.decreaseLiquidity()
        //              depois increaseLiquidity() com novo range
        // Em teste: apenas atualizar estado
        position.tickLower        = params.newTickLower;
        position.tickUpper        = params.newTickUpper;
        position.entryPrice       = params.currentPrice;
        position.lastRebalanceTs  = block.timestamp;
        position.rebalanceCount  += 1;

        if (params.liquidityDelta > 0) {
            position.liquidity = params.liquidityDelta;
        }

        dailyRebalanceCount += 1;

        emit Rebalanced(
            msg.sender,
            oldTickLower,
            oldTickUpper,
            params.newTickLower,
            params.newTickUpper,
            params.currentPrice,
            block.timestamp
        );
    }

    /**
     * @notice Abre posição inicial (primeiro deploy)
     */
    function openPosition(
        int24 tickLower,
        int24 tickUpper,
        uint256 entryPrice,
        uint128 liquidity
    )
        external
        onlyKeeper
        notPaused
    {
        require(position.liquidity == 0, "LPKeeper: position already open");
        require(tickLower < tickUpper, "LPKeeper: invalid ticks");
        require(entryPrice > 0, "LPKeeper: invalid price");

        position.tickLower       = tickLower;
        position.tickUpper       = tickUpper;
        position.entryPrice      = entryPrice;
        position.liquidity       = liquidity;
        position.lastRebalanceTs = block.timestamp;
        position.rebalanceCount  = 0;

        emit PositionOpened(tickLower, tickUpper, entryPrice, liquidity);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Circuit breaker
    // ─────────────────────────────────────────────────────────────────────────

    function triggerCircuitBreaker(string calldata reason) external {
        require(
            msg.sender == owner || msg.sender == keeper,
            "LPKeeper: not authorized"
        );
        paused = true;
        emit CircuitBreakerTriggered(msg.sender, reason);
    }

    function resetCircuitBreaker() external onlyOwner {
        paused = false;
        emit CircuitBreakerReset(msg.sender);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Emergency withdraw
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * @notice Retirar todos os fundos em emergência
     * @dev Em produção: chamar decreaseLiquidity(100%) + collect()
     */
    function emergencyWithdraw(address to) external onlyOwner {
        require(to != address(0), "LPKeeper: invalid address");

        uint256 bal0 = simulatedBalance0;
        uint256 bal1 = simulatedBalance1;

        // Zerar balances (em produção: transferir tokens reais)
        simulatedBalance0 = 0;
        simulatedBalance1 = 0;
        position.liquidity = 0;

        // Pausar após emergency
        paused = true;

        emit EmergencyWithdraw(to, bal0, bal1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Admin: configuração
    // ─────────────────────────────────────────────────────────────────────────

    function setKeeper(address newKeeper) external onlyOwner {
        require(newKeeper != address(0), "LPKeeper: zero address");
        emit KeeperUpdated(keeper, newKeeper);
        keeper = newKeeper;
    }

    function setMaxSlippage(uint256 bps) external onlyOwner {
        require(bps <= 500, "LPKeeper: slippage too high (max 5%)");
        maxSlippageBps = bps;
    }

    function setCooldown(uint256 seconds_) external onlyOwner {
        require(seconds_ >= 300, "LPKeeper: cooldown too short (min 5min)");
        cooldownSeconds = seconds_;
    }

    function setMaxRebalancesPerDay(uint256 max_) external onlyOwner {
        require(max_ >= 1 && max_ <= 48, "LPKeeper: invalid limit");
        maxRebalancesPerDay = max_;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Views
    // ─────────────────────────────────────────────────────────────────────────

    function getPosition() external view returns (Position memory) {
        return position;
    }

    function canRebalance() external view returns (bool ok, string memory reason) {
        if (paused) return (false, "circuit breaker active");
        if (block.timestamp < position.lastRebalanceTs + cooldownSeconds) {
            uint256 remaining = (position.lastRebalanceTs + cooldownSeconds) - block.timestamp;
            return (false, string(abi.encodePacked("cooldown: ", _uintToStr(remaining), "s remaining")));
        }
        if (dailyRebalanceCount >= maxRebalancesPerDay) return (false, "daily limit reached");
        return (true, "ok");
    }

    function secondsUntilCooldownEnd() external view returns (uint256) {
        uint256 end = position.lastRebalanceTs + cooldownSeconds;
        if (block.timestamp >= end) return 0;
        return end - block.timestamp;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Internos
    // ─────────────────────────────────────────────────────────────────────────

    function _validateSlippage(RebalanceParams calldata params) internal view {
        // Em produção: calcular amounts esperados pelo currentPrice e comparar
        // Em teste: verificação básica de sanidade
        if (position.liquidity > 0) {
            // Se há posição aberta, verificar que minAmounts são razoáveis (não zero)
            // 0 é permitido apenas se não houver liquidez ainda
            if (params.minAmount0 == 0 && params.minAmount1 == 0) {
                // Aceitar para facilitar testes — em produção exigir valores reais
                return;
            }

            // Slippage check básico: minAmount não pode ser maior que o saldo simulado
            require(
                params.minAmount0 <= simulatedBalance0,
                "LPKeeper: minAmount0 exceeds balance"
            );
            require(
                params.minAmount1 <= simulatedBalance1,
                "LPKeeper: minAmount1 exceeds balance"
            );
        }
    }

    function _uintToStr(uint256 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        uint256 tmp = v;
        uint256 len;
        while (tmp != 0) { len++; tmp /= 10; }
        bytes memory b = new bytes(len);
        while (v != 0) { b[--len] = bytes1(uint8(48 + v % 10)); v /= 10; }
        return string(b);
    }
}
