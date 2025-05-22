# LPP: Liquidity Pool Pollination

## 🌱 Overview

**Liquidity Pool Pollination (LPP)** is an autonomous algorithmic mechanism that harvests volatility between liquidity pools and migrates value across them efficiently. It uses automated supplication logic to navigate price divergence between different liquidity pools; a core innovation of the **[Market Automated Supplication System (MASS)](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS)**. 

---

MASS v1 observes weekly **median cbBTC prices** derived from two/three liquidity pools, simulates ±$100 divergence between pool prices, and dynamically determines when to:

- **Supplicate cbBTC** (convert USDC into cbBTC at the lower pool)
- **Supplicate USDC** (convert cbBTC into USDC at the higher pool)

---

# ⚙️ LPP Supplication Logic

**Based on a $5,000 cbBTC investment.**

## Scenario

- **Apr 25:** Begin with **$5,000 worth of cbBTC** (not a supplication).
- **Supplicate USDC** when the **low pool price** drops below the **previous highest low pool price**.
- After supplicating USDC, **hold for 7 days**.
- After the 7-day hold, **supplicate cbBTC** if the **low pool price** exceeds the price at which USDC was obtained.
- Otherwise, maintain position (Hold).

## Simulation Log

| Date     | Supplication        | cbBTC Price | Low Pool | High Pool | cbBTC Held | USDC Held | Wallet Value |
|----------|---------------------|-------------|----------|-----------|------------|-----------|--------------|
| Apr 25   | Initial Investment  | 93,189.07   | 93,189.07 | 93,389.07 | 0.05365    | 0.00      | $5,000.00    |
| Apr 27   | Supplicate USDC     | 93,669.80   | 93,669.80 | 93,869.80 | 0.00000    | $5,035.98 | $5,035.98    |
| May 4    | Hold                | 94,824.32   | 94,824.32 | 95,024.32 | 0.00000    | $5,035.98 | $5,035.98    |
| May 5    | Supplicate cbBTC    | 93,786.62   | 93,786.62 | 93,986.62 | 0.05369    | 0.00      | $5,035.98    |
| May 12   | Supplicate USDC     | 101,720.00  | 101,720.00 | 101,920.00 | 0.00000    | $5,464.88 | $5,464.88    |
| May 19   | Hold                | 102,160.00  | 102,160.00 | 102,360.00 | 0.00000    | $5,464.88 | $5,464.88    |
| May 20   | Supplicate cbBTC    | 104,690.00  | 104,690.00 | 104,890.00 | 0.05218    | 0.00      | $5,464.88    |
| May 21   | Supplicate USDC     | 107,660.00  | 107,460.00 | 107,660.00 | 0.00000    | $5,616.64 | $5,616.64    |
| May 22   | Hold                | 110,661.00  | 110,561.00 | 110,761.00 | 0.00000    | $5,616.64 | $5,616.64    |

## Wallet Value Progression

<img src="https://github.com/Art-Sells/HPM/blob/main/HPMCodeBase/MASS/LPP/WalletValueOverTime(basedonMASSv1LPP).png" width="600px"> 

## Key Principles

- **No speculation:** MASS only responds to price divergence logic.
- **No market timing:** It does not predict. It reacts to pool price data only.
- **Supplications, not trades:** All conversions occur via controlled MASS mechanisms.
- **Invariant supply logic:** cbBTC and USDC are always 100% accounted for.

## Result

- **Losses:** `$0.00`
- **Profits:** `$616.64`
- **% Return:** `+12.33%` over 4 weeks
