# Pool Growth Breakdown: ASSET vs USDC

## Actual Contract Behavior (from test)

### Pool 1 (Negative Offset: -5000 bps, USDC → ASSET)

**Initial State:**
- Reserve ASSET: 2,000,000,000,000,000,000 (raw) = **$2.00 ASSET**
- Reserve USDC: 2,000,000,000,000,000,000 (raw) = **$2.00 USDC**
- **Total Pool Value: $4.00**

**After Swap (USDC → ASSET):**
- Reserve ASSET: 1,970,000,000,000,000,000 (raw) = **$1.97 ASSET** (gave out 0.03 ASSET)
- Reserve USDC: 2,020,000,000,000,000,000 (raw) = **$2.02 USDC** (received $0.02 USDC - THE BORROWED AMOUNT STAYS IN)
- **Total Pool Value: $3.99** (lost $0.01)
  - The swap gives out 0.03 ASSET (worth $0.03 at fair price) but only receives $0.02 USDC
  - **Note:** PoolMath tests verify token conservation holds, but dollar value changes due to offset premium

**After Profit Deposit:**
- Reserve ASSET: 1,970,000,000,000,000,000 (raw) = **$1.97 ASSET** (unchanged)
- Reserve USDC: 2,029,482,900,000,000,000 (raw) = **$2.0294829 USDC** (gained $0.0094829 from profit deposit)
- **Total Pool Value: $3.9994829** (still down $0.0005171 from initial)

**Growth:**
- **ASSET Growth:** $1.97 - $2.00 = **-$0.03 (-1.5%)** (from swap)
- **USDC Growth:** $2.0294829 - $2.00 = **+$0.0294829 (+1.474%)**
  - From swap: +$0.02 (the borrowed amount stays in pool)
  - From profit deposit: +$0.0094829 (actual growth = **0.474%**)
- **Total Pool Value Growth:** $3.9994829 - $4.00 = **-$0.0005171 (-0.0129%)**

---

### Pool 4 (Positive Offset: +5000 bps, ASSET → USDC)

**Initial State:**
- Reserve ASSET: 2,000,000,000,000,000,000 (raw) = **$2.00 ASSET**
- Reserve USDC: 2,000,000,000,000,000,000 (raw) = **$2.00 USDC**
- **Total Pool Value: $4.00**

**After Swap (ASSET → USDC):**
- Reserve ASSET: 2,020,000,000,000,000,000 (raw) = **$2.02 ASSET** (received 0.02 ASSET - THE BORROWED AMOUNT STAYS IN)
- Reserve USDC: 1,970,000,000,000,000,000 (raw) = **$1.97 USDC** (gave out 0.03 USDC)
- **Total Pool Value: $3.99** (lost $0.01)

**After Profit Deposit:**
- Reserve ASSET: 2,029,482,900,000,000,000 (raw) = **$2.0294829 ASSET** (gained 0.0094829 ASSET from profit deposit)
- Reserve USDC: 1,970,000,000,000,000,000 (raw) = **$1.97 USDC** (unchanged)
- **Total Pool Value: $3.9994829** (still down $0.0005171 from initial)

**Growth:**
- **ASSET Growth:** $2.0294829 - $2.00 = **+$0.0294829 (+1.474%)**
  - From swap: +$0.02 (the borrowed amount stays in pool)
  - From profit deposit: +$0.0094829 (actual growth = **0.474%**)
- **USDC Growth:** $1.97 - $2.00 = **-$0.03 (-1.5%)** (from swap)
- **Total Pool Value Growth:** $3.9994829 - $4.00 = **-$0.0005171 (-0.0129%)**

---

## Summary Table

| Pool Type | Token | Initial | Final | Total Change | From Swap | From Profit | Actual Growth |
|-----------|-------|---------|-------|--------------|-----------|-------------|---------------|
| **Negative (1-3)** | USDC | $2.00 | $2.0294829 | +$0.0294829 | +$0.02 (stays in) | +$0.0094829 | **+0.474%** |
| **Negative (1-3)** | ASSET | $2.00 | $1.97 | -$0.03 | -$0.03 (given out) | $0.00 | 0% (no profit deposit) |
| **Negative (1-3)** | **TOTAL** | **$4.00** | **$3.9994829** | **-$0.0005171** | **-$0.01 (swap loss)** | **+$0.0094829** | **-0.0129%** |
| **Positive (4-6)** | ASSET | $2.00 | $2.0294829 | +$0.0294829 | +$0.02 (stays in) | +$0.0094829 | **+0.474%** |
| **Positive (4-6)** | USDC | $2.00 | $1.97 | -$0.03 | -$0.03 (given out) | $0.00 | 0% (no profit deposit) |
| **Positive (4-6)** | **TOTAL** | **$4.00** | **$3.9994829** | **-$0.0005171** | **-$0.01 (swap loss)** | **+$0.0094829** | **-0.0129%** |

---

## Key Observations

1. **Token Conservation:** PoolMath tests verify that token conservation holds (sum before = sum after per token)
2. **Dollar Value Loss:** The swap causes a $0.01 loss because it gives out 0.03 ASSET (worth $0.03) but only receives $0.02 USDC
3. **Profit Deposit:** Recovers $0.0094829 (95% of $0.009982 profit), but doesn't fully recover the swap loss
4. **Net Result:** Pool loses $0.0005171 (-0.0129%) per cycle due to the 5% treasury cut preventing full recovery

**Note:** The offset premium (50% more output) is working as designed, but it causes the pool to give out more value than it receives, resulting in a dollar value loss that isn't fully recovered by the profit deposit.

