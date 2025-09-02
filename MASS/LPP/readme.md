# LPP: Liquidity Pool Pollination

## Overview

**Liquidity Pool Pollination (LPP)** is an autonomous algorithmic mechanism that harvests volatility between liquidity pools and migrates value across them efficiently. It uses automated supplication logic to navigate price divergence between different liquidity pools; a core innovation of the **[Market Automated Supplication System (MASS)](https://github.com/Art-Sells/HPM/tree/main/MASS)**. 

#### Bear Market Investments

- **With HPM:** +0.009%-1%~ minimum profits, 0% losses.
- **Without HPM:** -100% maximum losses.

*For more info, see **[LPP v1 Expanded Results](https://github.com/Art-Sells/HPM/blob/main/MASS/LPP/v1Results.md
)***

---

MASS v1 observes weekly **median cbBTC prices** derived from two/three liquidity pools, simulates ±$100 divergence between pool prices, and dynamically determines when to:

- **Supplicate cbBTC** (convert USDC into cbBTC at the lower pool)
- **Supplicate USDC** (convert cbBTC into USDC at the higher pool)

---

## LPP v1 Scenario *(for MASS v1)*

*The below scenario is based on publicly available prices (which display by hours (and not seconds)).*

**Real MASS v1 USDC supplications activate with every minor price downswing (seconds and not hours) thus real losses will be much more negligible.**

### Scenario:

- Start: Invest $5,000 in cbBTC on Apr 22 at 4pm.
- Supplicate USDC when the high pool price is higher and a dip from prior low pool high is confirmed.
- Hold for 7 days after USDC supplication.
- Supplicate cbBTC when low pool price rises above last USDC supplication.
- **Avoid losses** by holding USDC in sustained downtrends.

### Investment Value (Bull vs Bear (April 25' - May 25' prices)):

<img src="https://github.com/Art-Sells/HPM/blob/main/MASS/LPP/BullVsBearMarketWalletComparison.png" width="800px"> 

### With HPM-MASS-LPP v1
- **Bull Return:** `+3.77%`
- **Bear Return:** `+0.009%`
- **Profits:** `+3.779%`

### Without HPM-MASS-LPP v1
- **Bull Return:** `+4.24%`
- **Bear Return:** `-5.47%`
- **Losses:** `-1.23%`

### In Summary:

LPP v1 (using MASS v1) gives up a small portion of upside during bull markets in exchange for virtually no downsides in bear markets thus rendering bear markets obsolete.

---

#### Bull Market Simulation Log (with HPM-MASS-LPP v1)

| Date         | Supplication        | cbBTC Price | Low Pool   | High Pool  | cbBTC Held | USDC Held | Wallet Value |
|--------------|---------------------|-------------|------------|------------|------------|-----------|--------------|
| Apr 22 - 4pm | Initial Investment  | 93,198.30   | 93,198.30  | 93,298.30  | 0.05365    | 0.00      | $5,000.00    |
| Apr 22 - 8pm | Supplicate USDC     | 94,181.20   | 94,181.20  | 94,281.20  | 0.00000    | 5,063.46  | $5,063.46    |
| Apr 28 - 8pm | Supplicate cbBTC    | 94,503.90   | 94,503.90  | 94,603.90  | 0.05358    | 0.00      | $5,074.18    |
| Apr 29 - 8am | Supplicate USDC     | 94,668.60   | 94,668.60  | 94,768.60  | 0.00000    | 5,083.00  | $5,083.00    |
| May 6 - 4pm  | Supplicate cbBTC    | 96,824.30   | 96,824.30  | 96,924.30  | 0.05261    | 0.00      | $5,093.52    |
| May 6 - 8pm  | Supplicate USDC     | 96,521.80   | 96,521.80  | 96,621.80  | 0.00000    | 5,083.00  | $5,083.00    |
| May 12 - 8pm | Supplicate cbBTC    | 101,772.00  | 101,772.00 | 101,872.00 | 0.05002    | 0.00      | $5,083.00    |
| May 13 - 8am | Supplicate USDC     | 103,679.00  | 103,679.00 | 103,779.00 | 0.00000    | 5,185.46  | $5,185.46    |
| May 22 - 8pm | Hold                | 106,500.00  | 106,500.00 | 106,600.00 | 0.00000    | 5,185.46  | $5,185.46    |

---

#### Bear Market Simulation Log (with HPM-MASS-LPP v1)

| Date           | Supplication        | cbBTC Price | Low Pool   | High Pool  | cbBTC Held | USDC Held | Wallet Value |
|----------------|---------------------|-------------|------------|------------|------------|-----------|--------------|
| Apr 22 - 4pm   | Initial Investment  | 110,809.00  | 110,809.00 | 110,909.00 | 0.04512    | 0.00      | $5,000.00    |
| Apr 22 - 8pm   | Hold                | 111,809.00  | 111,809.00 | 111,909.00 | 0.04512    | 0.00      | $5,037.93    |
| Apr 23 - 12am  | Supplicate USDC     | 110,878.00  | 110,878.00 | 110,978.00 | 0.00000    | 5,000.47  | $5,000.47    |
| Apr 28 - 8pm   | Hold                | 101,772.00  | 101,772.00 | 101,872.00 | 0.00000    | 5,000.47  | $5,000.47    |
| Apr 29 - 8am   | Hold                | 96,521.80   | 96,521.80  | 96,621.80  | 0.00000    | 5,000.47  | $5,000.47    |
| May 6 - 4pm    | Hold                | 96,824.30   | 96,824.30  | 96,924.30  | 0.00000    | 5,000.47  | $5,000.47    |
| May 6 - 8pm    | Hold                | 94,868.60   | 94,868.60  | 94,968.60  | 0.00000    | 5,000.47  | $5,000.47    |
| May 12 - 8pm   | Hold                | 94,703.90   | 94,703.90  | 94,803.90  | 0.00000    | 5,000.47  | $5,000.47    |
| May 13 - 8am   | Hold                | 94,181.20   | 94,181.20  | 94,281.20  | 0.00000    | 5,000.47  | $5,000.47    |
| May 22 - 8pm   | Hold                | 93,198.30   | 93,198.30  | 93,298.30  | 0.00000    | 5,000.47  | $5,000.47    |
