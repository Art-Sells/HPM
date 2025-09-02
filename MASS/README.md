# MASS (Market Automated Supplication System)

**MASS** is an asset management engine within the [HPM framework](https://github.com/Art-Sells/HPM) that automatically converts between a native Stablecoin and a volatile Asset (e.g., USDC and cbBTC) to preserve capital in downtrends and secure profits in upswings. This is achieved through activation per **Vatop Group**, not as an aggregate conversion system.

MASS is powered by **[LPP](https://github.com/Art-Sells/HPM/tree/main/MASS/LPP)** (Liquidity Pool Pollination), which ensures that all supplications occur at favorable prices across multiple liquidity pools — minimizing slippage, fees, and losses.

---

## How MASS Works

- MASS activates **per Vatop Group**.
- Each group maintains its own **cpVact (HAP)** — the price at which the last supplication was made using the **lowest pool price**.
- **LPP logic** ensures supplication occurs:
  - **USDC → cbBTC** at the **lowest pool**
  - **cbBTC → USDC** at the **highest pool**
- MASS **holds** after supplications, reducing unnecessary fees and protecting assets in volatile markets.

---

## Example (without LPP convergence):

### 1. Bitcoin Price: $60,000  
- **Action**: $500 worth of cbBTC is imported using the lowest pool  
- **Lowest Pool**: $59,900  
- **Highest Pool**: $60,100  
- **HPAP / cpVact**: $59,900 (recorded from lowest pool at time of import)  
- **Vatop Group 1**:
  - `cpVact`: $59,900  
  - `cVactTaa`: 0.00834 BTC  
- **Investment Results**:
  - **Profits:** $0  
  - **Losses:** $0  

---

### 2. Bitcoin Price: $54,000  
- **Action**: $600 worth of cbBTC is imported using lowest pool  
- **Lowest Pool**: $53,900  
- **Highest Pool**: $54,100  
- **HPAP Remains**: $59,900 (no higher pool has surpassed it)  
- **Vatop Group 1** *(MASS Activated)*:
  - `cpVact`: $59,900  
  - `cVactTaa`: 0 BTC  
  - `cVactDa`: $500 (cbBTC → USDC at $59,900 high pool)  
- **Vatop Group 2**:
  - `cpVact`: $53,900  
  - `cVactTaa`: 0.01113 BTC  
  - `cVactDa`: $0  
- **Investment Results**:
  - **Profits:** $0  
  - **Losses:** $0  

---

### 3. Bitcoin Price: $65,000  
- **Action**: No import  
- **Lowest Pool**: $64,900  
- **Highest Pool**: $65,100  
- **Vatop Group 1** *(MASS Activated)*:
  - `cpVact`: $65,100  
  - `cVactTaa`: 0.00834 BTC (USDC → cbBTC at $64,900 low pool)  
  - `cVactDa`: $0  
- **Vatop Group 2**:
  - `cpVact`: $65,100  
  - `cVactTaa`: 0.01113 BTC  
  - `cVactDa`: $0  
- **Investment Results**:
  - **Profits:** +$164  
  - **Losses:** $0  

---

### 4. Bitcoin Price: $63,000  
- **Action**: No import  
- **Lowest Pool**: $62,900  
- **Highest Pool**: $63,100  
- **Vatop Group 1** *(MASS Activated)*:
  - `cpVact`: $65,100  
  - `cVactTaa`: 0 BTC  
  - `cVactDa`: $542 (cbBTC → USDC at $63,100 high pool)  
- **Vatop Group 2** *(MASS Activated)*:
  - `cpVact`: $65,100  
  - `cVactTaa`: 0 BTC  
  - `cVactDa`: $722  
- **Investment Results**:
  - **Profits:** +$164  
  - **Losses:** $0  

---

## Fees & Constraints

- Details: [MASS Fee Constraints & Calculations](https://github.com/Art-Sells/HPM/tree/main/MASS/MASSCodeBase#fee-constraintscalculations)

