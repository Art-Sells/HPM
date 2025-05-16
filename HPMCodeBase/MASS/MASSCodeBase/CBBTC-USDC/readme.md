# CBBTC/USDC MASS

## Version 1

This system performs **fee-free swaps** between `CBBTC` and `USDC` using Uniswap V3 on the Base network. It leverages tick-level routing and QuoterV2 simulations to ensure that all swaps avoid liquidity fees.

---

## 1. Overview

There are two primary flows:

- **CBBTC → USDC Supplication**
- **USDC → CBBTC Supplication**

Each flow:
- Checks for a valid fee-free tick
- Simulates the output using Uniswap's Quoter contract
- Approves token allowances
- Executes the swap only if fee-free conditions are met

---

## 2. Pool and Contract Setup

The code defines and interacts with:

- **Uniswap Factory**: Used to retrieve the pool address for a token pair at a specific fee tier.
- **Uniswap Quoter (V2)**: Used to simulate swap output without executing transactions.
- **Uniswap SwapRouter02**: Executes the actual swap if conditions are met.
- **Token Contracts**: Standard ERC-20 interfaces are used to check balances, allowances, and approvals.

---

## 3. Fee-Free Route Discovery

The system determines whether a fee-free route exists by:

1. Fetching the current tick and liquidity from the target pool.
2. Identifying a set of 3 consecutive ticks within the pool’s tick spacing.
3. For each tick:
   - Computing the corresponding `sqrtPriceLimitX96` using `TickMath`.
   - Simulating the swap using the QuoterV2 contract.
   - Validating the output is non-zero (indicating the route is viable).

If a valid simulation result is returned, the tick is considered fee-free.

---

## 4. Token-Specific Logic

### CBBTC → USDC:

- `amountIn` is CBBTC with 8 decimals.
- Quoter is called using `quoteExactInputSingle` with CBBTC as `tokenIn` and USDC as `tokenOut`.
- Simulated result is compared in 6-decimal format (USDC).
- Only proceeds with a swap if the simulated output is greater than zero.
- Swap uses `exactInputSingle` with `sqrtPriceLimitX96` for price control.

### USDC → CBBTC:

- `amountIn` is USDC with 6 decimals.
- Quoter is called with USDC as `tokenIn` and CBBTC as `tokenOut`.
- Simulated result is compared in 8-decimal format (CBBTC).
- Same validation logic applies as the CBBTC path.

---

## 5. Approval and ETH Balance Verification

Before any swap executes:
- The relevant token (`CBBTC` or `USDC`) must be approved for `SwapRouter02`.
- Existing allowances are checked and compared to `amountIn`.
- If allowance is insufficient, an approval transaction is sent.
- ETH balance is checked to ensure enough gas is available for the transaction (estimated at 70,000 gas units or more).
- If not enough ETH is available, the swap does not proceed.

---

## 6. Retry and Execution Logic

Each supplication function wraps the entire process in a retry loop:

- It continuously checks for a fee-free route.
- If one is found, it attempts the swap.
- If the transaction fails, it logs the error and waits 15 seconds before retrying.
- This allows the system to adapt to pool changes in real-time and avoid failed swaps due to shifting liquidity or gas price spikes.

---

## 7. Testing and Simulation

For both flows, the developer can run:

```bash
yarn hardhat run test/cbbtc_mass_test.js --network base
yarn hardhat run test/usdc_mass_test.js --network base
