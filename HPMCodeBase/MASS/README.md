# MASS (Market Automated Supplication System)
MASS or Market Automated Supplication System is a system built under the [HPM](https://github.com/Art-Sells/HPM) that automatically supplicates a native Stablecoin<>Asset in order to ensure losses are rarely incured (and profits rarely lost) during market downswings and profits are always gained during upswings, this is technically acheived through [LPP](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS/LPP).

## In a Nutshell
MASS is not an aggregate "supplication system" meaning when activated, it does not automatically supplicate all assets into a stablecoin (and vise versa). The reason for this is because profits cannot be gained if MASS were to aggregatetely supplicate assets. In order to gain the most amounts of profits as possible, MASS (with HPM) activates individually per Vatop Group.

## Example Scenario (without LPP):

### 1. Bitcoin Price: $60,000
- **Action**: $500 worth of Bitcoin is purchased/imported.
- **HPAP**: $60,000.
- **Vatop Group 1**:
  - cpVact (or HAP): $60,000.
  - cVactTaa: 0.00833 BTC.
- **Investment Profits & Losses**:
  - ***Profits (acdVatops): $0***.
  - ***Losses: $0***.

---

### 2. Bitcoin Price: $54,000
- **Action**: $600 worth of Bitcoin is purchased/imported.
- **HPAP**: $60,000.
- **Vatop Group 1** *(MASS activated)*:
  - cpVact (or HAP): $60,000.
  - cVactTaa: 0 BTC.
  - cVactDa: $500 *(in USD supplicated from BTC)*.
- **Vatop Group 2**:
  - cpVact (or HAP): $54,000.
  - cVactTaa: 0.01111 BTC.
  - cVactDa: $0.
- **Investment Profits & Losses**:
  - ***Profits (acdVatops): $0***.
  - ***Losses: $0***.

---

### 3. Bitcoin Price: $65,000
- **Action**: No Bitcoin purchased/imported.
- **HPAP**: $65,000.
- **Vatop Group 1** *(MASS activated)*:
  - cpVact (or HAP): $65,000.
  - cVactTaa: 0.00833 BTC *(supplicated back into BTC from USD)*.
  - cVactDa: $0.
- **Vatop Group 2**:
  - cpVact (or HAP): $65,000.
  - cVactTaa: 0.01111 BTC.
  - cVactDa: $0.
- **Investment Profits & Losses**:
  - ***Profits (acdVatops): +$164***.
  - ***Losses: $0***.

---

### 4. Bitcoin Price: $63,000
- **Action**: No Bitcoin purchased/imported.
- **HPAP**: $65,000.
- **Vatop Group 1** *(MASS activated)*:
  - cpVact (or HAP): $65,000.
  - cVactTaa: 0 BTC.
  - cVactDa: $542 *(in USD supplicated from BTC)*.
- **Vatop Group 2** *(MASS activated)*:
  - cpVact (or HAP): $65,000.
  - cVactTaa: 0 BTC.
  - cVactDa: $722 *(in USD supplicated from BTC)*.
- **Investment Profits & Losses**:
  - ***Profits (acdVatops): +$164***.
  - ***Losses: $0***.
---

### FAQ (Frequently Asked Question/s):
- What about supplication fees?
  - MASS is currently integrating [BASE](https://base.org) into its framework. Base currently incurs an average ~$0.01 fee per supplication so we're working to keep MASS as efficient as possible by decreasing the mount of activations per second/minute/hour per "Vatop Group". So the more Vatop Groups incured in your account, the less often MASS is activated.
  - More Info: [MASS Fee Constraints & Calculations](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS/MASSCodeBase#fee-constraintscalculations)
---
### Other Know-how
MASS is currently in Version 1 of production so MASS's base "activation time" increments and decrements based on the amount of assets currently held within Arells so (assuming price changes occur frequently) Fee Constraints and Calculations are in-built into the system.

