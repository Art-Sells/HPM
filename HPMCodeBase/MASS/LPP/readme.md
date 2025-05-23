# LPP: Liquidity Pool Pollination

## 🌱 Overview

**Liquidity Pool Pollination (LPP)** is an autonomous algorithmic mechanism that harvests volatility between liquidity pools and migrates value across them efficiently. It uses automated supplication logic to navigate price divergence between different liquidity pools; a core innovation of the **[Market Automated Supplication System (MASS)](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS)**. 

---

MASS v1 observes weekly **median cbBTC prices** derived from two/three liquidity pools, simulates ±$100 divergence between pool prices, and dynamically determines when to:

- **Supplicate cbBTC** (convert USDC into cbBTC at the lower pool)
- **Supplicate USDC** (convert cbBTC into USDC at the higher pool)

---

## ⚙️ LPP Supplication Logic *(for MASS v1)*

**Based on a $5,000 cbBTC investment starting April 22, 2025.**

### Scenario:

- Start: Invest $5,000 in cbBTC on Apr 22 at 4pm.
- Supplicate USDC when the high pool price is higher and a dip from prior low pool high is confirmed.
- Hold for 7 days after USDC supplication.
- Supplicate cbBTC when low pool price rises above last USDC supplication.
- **Avoid losses** by holding USDC in sustained downtrends.

### Wallet Value (Bull vs Bear)

<img src="https://github.com/Art-Sells/HPM/blob/main/HPMCodeBase/MASS/LPP/BullVsBearMarketWallets.png" width="800px"> 

**Bull Market Wallet Value (with HPM-MASS v1):**
- **Total Gains:** `$198.96`
- **Total Losses:** `$10.52`
- **Net Profit:** `$188.44`
- **% Return:** `+3.77%`

**Bull Market Wallet Value (without HPM-MASS v1):**
- **Total Gains:** `$300.09`
- **Total Losses:** `$88.61`
- **Net Profit:** `$211.48`
- **% Return:** `+4.24%`

**Bear Market Wallet Value (with HPM-MASS v1):**
- **Total Gains:** `$63.46`
- **Total Losses:** `$0.00`
- **Net Profit:** `$63.46`
- **% Return:** `+1.27%`

**Bear Market Wallet Value (without HPM-MASS v1):**
- **Total Gains:** `$0.00`
- **Total Losses:** `$274.16`
- **Net Loss:** `$274.16`
- **% Return:** `-5.47%`

---

### In Summary:

LPP (using MASS v1) gives up a small portion of upside in exchange for no downside insulation built to render bear markets obsolete.

#### Bull Market Simulation Log

| Date         | Supplication        | cbBTC Price | Low Pool | High Pool | cbBTC Held | USDC Held | Wallet Value |
|--------------|---------------------|-------------|----------|-----------|------------|-----------|--------------|
| Apr 22 - 4pm | Initial Investment  | 93,198.30   | 93,198.30 | 93,398.30 | 0.05365    | 0.00      | $5,000.00    |
| Apr 22 - 8pm | Supplicate USDC     | 94,181.20   | 94,181.20 | 94,381.20 | 0.00000    | 5,063.46  | $5,063.46    |
| Apr 28 - 8pm | Supplicate cbBTC    | 94,703.90   | 94,503.90 | 94,703.90 | 0.05358    | 0.00      | $5,074.18    |
| Apr 29 - 8am | Supplicate USDC     | 94,868.60   | 94,668.60 | 94,868.60 | 0.00000    | 5,083.00  | $5,083.00    |
| May 6 - 4pm  | Supplicate cbBTC    | 96,824.30   | 96,624.30 | 96,824.30 | 0.05261    | 0.00      | $5,093.52    |
| May 6 - 8pm  | Supplicate USDC     | 96,521.80   | 96,321.80 | 96,521.80 | 0.00000    | 5,083.00  | $5,083.00    |
| May 12 - 8pm | Supplicate cbBTC    | 101,772.00  | 101,572.00| 101,772.00| 0.05002    | 0.00      | $5,083.00    |
| May 13 - 8am | Supplicate USDC     | 103,679.00  | 103,479.00| 103,679.00| 0.00000    | 5,185.46  | $5,185.46    |
| May 22 - 8pm | Hold                | 106,500.00  | 106,300.00| 106,700.00| 0.00000    | 5,185.46  | $5,185.46    |

#### Bear Market Simulation Log

| Date         | Supplication        | cbBTC Price | Low Pool | High Pool | cbBTC Held | USDC Held | Wallet Value |
|--------------|---------------------|-------------|----------|-----------|------------|-----------|--------------|
| Apr 22 - 4pm | Initial Investment  | 93,198.30   | 93,198.30 | 93,398.30 | 0.05365    | 0.00      | $5,000.00    |
| Apr 22 - 8pm | Hold                | 93,200.00   | 93,200.00 | 93,400.00 | 0.05365    | 0.00      | $5,001.15    |
| Apr 28 - 8pm | Supplicate USDC     | 92,750.00   | 92,600.00 | 92,800.00 | 0.00000    | 4,978.63  | $4,978.63    |
| Apr 29 - 8am | Hold                | 92,450.00   | 92,300.00 | 92,500.00 | 0.00000    | 4,978.63  | $4,978.63    |
| May 6 - 4pm  | Hold                | 91,700.00   | 91,500.00 | 91,800.00 | 0.00000    | 4,978.63  | $4,978.63    |
| May 6 - 8pm  | Hold                | 91,400.00   | 91,200.00 | 91,500.00 | 0.00000    | 4,978.63  | $4,978.63    |
| May 12 - 8pm | Hold                | 91,000.00   | 90,800.00 | 91,100.00 | 0.00000    | 4,978.63  | $4,978.63    |
| May 13 - 8am | Hold                | 90,500.00   | 90,200.00 | 90,600.00 | 0.00000    | 4,978.63  | $4,978.63    |
| May 22 - 8pm | Hold                | 90,000.00   | 89,800.00 | 90,100.00 | 0.00000    | 4,978.63  | $4,978.63    |

