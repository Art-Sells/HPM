# LPP: Liquidity Pool Pollination

## 🌱 Overview

**Liquidity Pool Pollination (LPP)** is an autonomous algorithmic mechanism that harvests volatility between liquidity pools and migrates value across them efficiently. It uses automated supplication logic to navigate price divergence between different liquidity pools; a core innovation of the **[Market Automated Supplication System (MASS)](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS)**. 

---

MASS v1 observes weekly **median cbBTC prices** derived from two/three liquidity pools, simulates ±$100 divergence between pool prices, and dynamically determines when to:

- **Supplicate cbBTC** (convert USDC into cbBTC at the lower pool)
- **Supplicate USDC** (convert cbBTC into USDC at the higher pool)

---

## ⚙️ LPP Supplication Logic *(example)*

**Based on a $5,000 cbBTC investment *(from April 25th 25' to May 22nd 25')*.**

Scenario:
- Begin with **$5,000 worth of cbBTC**..
- Each following week:
  - If **cbBTC is held** and the **high pool price exceeds prior week’s median**, then **supplicate USDC**.
  - If **USDC is held** and the **low pool price drops below prior week’s median**, then **supplicate cbBTC**.
  - Otherwise, maintain position (Hold).

### Simulation Log

| Date     | Supplication        | cbBTC Price | Low Pool | High Pool | cbBTC Held | USDC Held | Wallet Value |
|----------|---------------------|-------------|----------|-----------|------------|-----------|--------------|
| Apr 25   | Supplicate cbBTC    | 87172.16    | 87072.16 | 87272.16  | 0.05737    | 0.00      | $5,000.00    |
| May 2    | Supplicate USDC     | 94076.62    | 93976.62 | 94176.62  | 0.00000    | $5,407.96 | $5,407.96    |
| May 9    | Hold                | 103938.40   | 103838.4 | 104038.4  | 0.00000    | $5,407.96 | $5,407.96    |
| May 16   | Supplicate cbBTC    | 103760.00   | 103660.0 | 103860.0  | 0.05217    | 0.00      | $5,413.18    |
| May 21   | Supplicate USDC     | 107560.00   | 107460.0 | 107660.0  | 0.00000    | $5,616.64 | $5,616.64    |
| May 22   | Hold                | 110661.00   | 110561.0 | 110761.0  | 0.00000    | $5,616.64 | $5,616.64    |

### Wallet Value Progression

<img src="https://github.com/Art-Sells/HPM/blob/main/HPMCodeBase/MASS/LPP/WalletValueOverTime(basedonMASSv1LPP).png" width="600px"> 

### Key Principles

- **No speculation:** MASS only responds to price divergence logic.
- **No market timing:** It does not predict. It reacts to pool price data only.
- **Supplications, not trades:** All conversions occur via controlled MASS mechanisms.
- **Invariant supply logic:** cbBTC and USDC are always 100% accounted for.

### Result

- **Losses**: `$0.00`
- **Profits**: `$616.64`
- **% Return**: `+12.33%` over 4 weeks
