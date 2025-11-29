# Daily Operations Snapshot Analysis (in USD)

## Summary
**Date:** 2025-11-29  
**Total Operations:** 6 pools processed  
**Status:** ✅ Completed  
**Rebalances:** 0 (no imbalances detected)

---

## Pool Operations Breakdown

### Pools 1-3 (Negative Offset: -5000 bps, USDC → ASSET)

#### Pool 1 (0x856e...)
**Initial State:**
- Reserve ASSET: 100 ASSET
- Reserve USDC: 100 USDC
- Price (USDC/ASSET): ~0.396 (Q96 format: 39614081257132168796771975168)

**Operation:**
- **Borrowed:** $1.00 USDC
- **Swapped:** $1.00 USDC → 1.5 ASSET (50% discount via -5000 bps)
  - Pool reserves after swap:
    - Reserve ASSET: 98.5 ASSET (decreased by 1.5)
    - Reserve USDC: 101 USDC (increased by 1)
    - Price (USDC/ASSET): ~1.219 (Q96 format: 121858544374731443100730035288)
- **External Sale:** 1.5 ASSET sold externally
- **Profit Deposited:** 0.0015 ASSET
  - **Pool State Before Deposit:**
    - Reserve ASSET: 98.5 ASSET
    - Reserve USDC: 101 USDC
  - **Pool State After Deposit:**
    - Reserve ASSET: 98.501425 ASSET (increased by 0.001425)
    - Reserve USDC: 101 USDC (unchanged)
  - **Treasury State Before:** 1,000,000 ASSET, 1,000,000 USDC
  - **Treasury State After:** 1,000,000.075 ASSET (increased by 0.000075), 1,000,000 USDC
  - **To Pool:** 0.001425 ASSET (95%)
  - **To Treasury:** 0.000075 ASSET (5%)
- **Repaid:** $1.00 USDC principal

#### Pool 2 (0xb027...)
**Initial State:**
- Reserve ASSET: 100 ASSET
- Reserve USDC: 100 USDC
- Price (USDC/ASSET): ~0.396

**Operation:**
- **Borrowed:** $1.00 USDC
- **Swapped:** $1.00 USDC → 1.5 ASSET
  - Pool reserves after swap:
    - Reserve ASSET: 98.5 ASSET
    - Reserve USDC: 101 USDC
    - Price (USDC/ASSET): ~1.219
- **External Sale:** 1.5 ASSET sold externally
- **Profit Deposited:** 0.0015 ASSET
  - **Pool State After Deposit:**
    - Reserve ASSET: 98.50285 ASSET (increased by 0.001425)
    - Reserve USDC: 101 USDC
  - **Treasury State Before:** 1,000,000.075 ASSET, 1,000,000 USDC
  - **Treasury State After:** 1,000,000.15 ASSET (increased by 0.000075), 1,000,000 USDC
- **Repaid:** $1.00 USDC principal

#### Pool 3 (0x3dE2...)
**Initial State:**
- Reserve ASSET: 100 ASSET
- Reserve USDC: 100 USDC
- Price (USDC/ASSET): ~0.396

**Operation:**
- **Borrowed:** $1.00 USDC
- **Swapped:** $1.00 USDC → 1.5 ASSET
  - Pool reserves after swap:
    - Reserve ASSET: 98.5 ASSET
    - Reserve USDC: 101 USDC
    - Price (USDC/ASSET): ~1.219
- **External Sale:** 1.5 ASSET sold externally
- **Profit Deposited:** 0.0015 ASSET
  - **Pool State After Deposit:**
    - Reserve ASSET: 98.504275 ASSET (increased by 0.001425)
    - Reserve USDC: 101 USDC
  - **Treasury State Before:** 1,000,000.15 ASSET, 1,000,000 USDC
  - **Treasury State After:** 1,000,000.225 ASSET (increased by 0.000075), 1,000,000 USDC
- **Repaid:** $1.00 USDC principal

### Pools 4-6 (Positive Offset: +5000 bps, ASSET → USDC)

#### Pool 4 (0xddEA...)
**Initial State:**
- Reserve ASSET: 100 ASSET
- Reserve USDC: 100 USDC
- Price (USDC/ASSET): ~1.188 (Q96 format: 118842243771396506390315925504)

**Operation:**
- **Borrowed:** 0.000012 ASSET (~$0.000008)
- **Swapped:** 0.000012 ASSET → 0.000018 USDC (1.5× multiplier)
  - Pool reserves after swap:
    - Reserve ASSET: 100.000012 ASSET (increased by 0.000012)
    - Reserve USDC: 99.999982 USDC (decreased by 0.000018)
    - Price (USDC/ASSET): ~0.396 (Q96 format: 39614069372909217763875460083)
- **External Sale:** 0.000018 USDC sold externally
- **Profit Deposited:** $0.000000018 USDC
  - **Pool State After Deposit:**
    - Reserve ASSET: 100.000012 ASSET (unchanged)
    - Reserve USDC: 99.9999820000000171 USDC (increased by 0.0000000171)
  - **Treasury State Before:** 1,000,000.225 ASSET, 1,000,000 USDC
  - **Treasury State After:** 1,000,000.225 ASSET, 1,000,000.0000000027 USDC (increased by 0.0000000009)
- **Repaid:** 0.000012 ASSET principal

#### Pool 5 (0xAbB6...)
**Initial State:**
- Reserve ASSET: 100 ASSET
- Reserve USDC: 100 USDC
- Price (USDC/ASSET): ~1.188

**Operation:**
- **Borrowed:** 0.000012 ASSET (~$0.000008)
- **Swapped:** 0.000012 ASSET → 0.000018 USDC
  - Pool reserves after swap:
    - Reserve ASSET: 100.000012 ASSET
    - Reserve USDC: 99.999982 USDC
    - Price (USDC/ASSET): ~0.396
- **External Sale:** 0.000018 USDC sold externally
- **Profit Deposited:** $0.000000018 USDC
  - **Pool State After Deposit:**
    - Reserve ASSET: 100.000012 ASSET
    - Reserve USDC: 99.9999820000000342 USDC (increased by 0.0000000171)
  - **Treasury State After:** 1,000,000.225 ASSET, 1,000,000.0000000054 USDC (increased by 0.0000000009)
- **Repaid:** 0.000012 ASSET principal

#### Pool 6 (0x7e91...)
**Initial State:**
- Reserve ASSET: 100 ASSET
- Reserve USDC: 100 USDC
- Price (USDC/ASSET): ~1.188

**Operation:**
- **Borrowed:** 0.000012 ASSET (~$0.000008)
- **Swapped:** 0.000012 ASSET → 0.000018 USDC
  - Pool reserves after swap:
    - Reserve ASSET: 100.000012 ASSET
    - Reserve USDC: 99.999982 USDC
    - Price (USDC/ASSET): ~0.396
- **External Sale:** 0.000018 USDC sold externally
- **Profit Deposited:** $0.000000018 USDC
  - **Pool State After Deposit:**
    - Reserve ASSET: 100.000012 ASSET
    - Reserve USDC: 99.9999820000000513 USDC (increased by 0.0000000171)
  - **Treasury State After:** 1,000,000.225 ASSET, 1,000,000.0000000081 USDC (increased by 0.0000000009)
- **Repaid:** 0.000012 ASSET principal

---

## Totals

### Borrows
- **USDC:** $3.00 (3 pools × $1.00)
- **ASSET:** 0.000036 ASSET (~$0.000024) (3 pools × 0.000012)

### Swaps
- **Negative Pools:** 3 swaps, $3.00 USDC → 4.5 ASSET
  - Each pool: 100 ASSET → 98.5 ASSET, 100 USDC → 101 USDC
- **Positive Pools:** 3 swaps, 0.000036 ASSET → 0.000054 USDC
  - Each pool: 100 ASSET → 100.000012 ASSET, 100 USDC → 99.999982 USDC

### External Sales
- **ASSET:** 4.5 ASSET sold externally
- **USDC:** $0.000054 USDC sold externally

### Profit Deposits
- **ASSET to Pools:** 0.004275 ASSET (3 pools × 0.001425)
- **ASSET to Treasury:** 0.000225 ASSET (3 pools × 0.000075)
- **USDC to Pools:** $0.0000000513 USDC (3 pools × $0.0000000171)
- **USDC to Treasury:** $0.0000000027 USDC (3 pools × $0.0000000009)

### Final Treasury Balance
- **ASSET:** 1,000,000.225 ASSET (started with 1,000,000, gained 0.000225)
- **USDC:** 1,000,000.0000000081 USDC (started with 1,000,000, gained 0.0000000081)

### Rebalances
- **None:** No imbalances detected (all pools balanced)

---

## Key Observations

1. **Price Impact:** 
   - Negative pools: Price changed from ~0.396 to ~1.219 USDC/ASSET after swap (offset flip)
   - Positive pools: Price changed from ~1.188 to ~0.396 USDC/ASSET after swap (offset flip)

2. **Pool Reserve Changes:**
   - Negative pools: ASSET decreased by 1.5, USDC increased by 1.0 per swap
   - Positive pools: ASSET increased by 0.000012, USDC decreased by 0.000018 per swap

3. **Treasury Growth:**
   - ASSET: +0.000225 ASSET (~$0.00015)
   - USDC: +$0.0000000081 USDC

4. **Pool Growth:**
   - Each negative pool: +0.001425 ASSET from profit deposits
   - Each positive pool: +$0.0000000171 USDC from profit deposits

5. **Offset Flip:** After each swap, the pool's offset flips (negative becomes positive, positive becomes negative), which is why prices change dramatically.
