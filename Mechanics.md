# HPM Mechanics

## [Code Base Architecture](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase)

## In a Nutshell:
If you purchase/import Bitcoin into Arells at $60k (for example), the HPM holds that price for you ensuring your investment never loses value thanks to a new system called ***[MASS(Market Automated Supplication System)](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS)***; this is also achieved if the Bitcoin price falls lower than $60k.

Then, once (or if) the Bitcoin price rises over $60k, MASS is activated, this way, you’re consistently riding up profits during bull markets, and never experiencing losses during bear markets (without even having to think about it).

It gets even better…

If Bitcoin rises above the price you imported/purchased ($60k in this instance) to $65k then falls to $63k, the $65k price is held. This means, you will never lose any profits you made on the upswing when the downswing occurs (even if the Bitcoin price drops to $0 thanks to MASS).

The HPM (whenever a sale occurs) subtracts from your wallet based on the highest price you imported/purchased your Bitcoin (or asset) at ensuring you continue to accumulate the maximum amounts of profits possible.

***HPM & MASS in action: [arells.com/concept](https://arells.com/concept)***

## Terminology and Calculations

### HPAP = Highest Price After Purchase
- The highest `cpVact` across all groups. Defaults to 0 if no groups exist.

### HAP = Highest Asset Price
- The same value as the `cpVact` for each VatopGroup.

---

### Vatop = Value At Time Of Purchase
- **cVatop**: Value of Bitcoin investment at the time of purchase or import.
- **cpVatop**: Bitcoin price at the time of purchase or import.
- **cdVatop**: Difference between `cVact` and `cVatop`: cdVatop = cVact - cVatop
- **acVatops**: Sum of all `cVatop` values across VatopGroups.
- **acdVatops**: Sum of all positive `cdVatop` values; negative values are excluded.

---

### Vact = Value At Current Time
- **cVact**: Current value of Bitcoin investment, which starts as `cVatop` and increases as `cpVact` grows.
- **cpVact**: Current price of Bitcoin; begins as `cpVatop` and adjusts based on the highest Bitcoin price observed (`HAP`).
- **cVactTa**: Token amount of Bitcoin at purchase/import time.
- **cVactTaa**: Token amount of Bitcoin available for swapping back to Bitcoin if the current Bitcoin price (`BitcoinPrice`) is greater than or equal to `cpVact`. This triggers MASS orchestration.
- **cVactDa**: Dollar amount available to swap Bitcoin into a Stablecoin if the current Bitcoin price (`BitcoinPrice`) is less than `cpVact`. This also triggers MASS orchestration.
- **acVacts**: Sum of all `cVact` values across VatopGroups.
- **acVactTas**: Sum of all `cVactTa` values across VatopGroups.
- **acVactTaa**: Sum of all `cVactTaa` values across VatopGroups.
- **acVactDas**: Sum of all `cVactDa` values across VatopGroups.

---

## Example Scenarios

### 1. Bitcoin Price: $60,000
- **Action**: $500 worth of Bitcoin purchased/imported.
- **Results**:
  - `HPAP` = $60,000.
  - Vatop Group 1:
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $500, `cpVact` = $60,000.
    - `cVactTa` = 0.00833 BTC, `cVactTaa` = 0.00833 BTC, `cVactDa` = $0, `cdVatop` = $0.
  - Combinations:
    - `acVatops` = $500, `acVacts` = $500.
    - `acVactTas` = 0.00833 BTC, `acVactTaa` = 0.00833 BTC, `acVactDas` = $0.
    - `acdVatops` = $0.

---

### 2. Bitcoin Price: $54,000
- **Action**: $600 worth of Bitcoin purchased/imported.
- **Results**:
  - `HPAP` = $60,000.
  - Vatop Group 1:
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $500, `cpVact` = $60,000.
    - `cVactTa` = 0.00833 BTC, `cVactTaa` = $0 BTC, `cVactDa` = $500, `cdVatop` = $0.
  - Vatop Group 2:
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $600, `cpVact` = $54,000.
    - `cVactTa` = 0.01111 BTC, `cVactTaa` = 0.01111 BTC, `cVactDa` = $0, `cdVatop` = $0.
  - Combinations:
    - `acVatops` = $1,100, `acVacts` = $1,100.
    - `acVactTas` = 0.01944 BTC, `acVactTaa` = 0.01111 BTC, `acVactDas` = $500.
    - `acdVatops` = $0.

---

### 3. Bitcoin Price: $55,000
- **Action**: No Bitcoin purchased/imported.
- **Results**:
  - `HPAP` = $60,000.
  - Vatop Group 1:
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $500, `cpVact` = $60,000.
    - `cVactTa` = 0.00833 BTC, `cVactTaa` = $0 BTC, `cVactDa` = $500, `cdVatop` = $0.
  - Vatop Group 2:
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $611, `cpVact` = $55,000.
    - `cVactTa` = 0.01111 BTC, `cVactTaa` = 0.01111 BTC, `cVactDa` = $0, `cdVatop` = $11.
  - Combinations:
    - `acVatops` = $1,100, `acVacts` = $1,111.
    - `acVactTas` = 0.01944 BTC, `acVactTaa` = 0.01111 BTC, `acVactDas` = $500.
    - `acdVatops` = $11.

---

### 4. Bitcoin Price: $65,000
- **Action**: $200 worth of Bitcoin purchased/imported.
- **Results**:
  - `HPAP` = $65,000.
  - Vatop Group 1:
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $542, `cpVact` = $65,000.
    - `cVactTa` = 0.00833 BTC, `cVactTaa` = 0.00833 BTC, `cVactDa` = $0, `cdVatop` = $42.
  - Vatop Group 2:
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $722, `cpVact` = $65,000.
    - `cVactTa` = 0.01111 BTC, `cVactTaa` = 0.01111 BTC, `cVactDa` = $0, `cdVatop` = $122.
  - Vatop Group 3:
    - `cVatop` = $200, `cpVatop` = $65,000, `cVact` = $200, `cpVact` = $65,000.
    - `cVactTa` = 0.00308 BTC, `cVactTaa` = 0.00308 BTC, `cVactDa` = $0, `cdVatop` = $0.
  - Combinations:
    - `acVatops` = $1,300, `acVacts` = $1,464.
    - `acVactTas` = 0.02252 BTC, `acVactTaa` = 0.02252 BTC, `acVactDas` = $0.
    - `acdVatops` = $164.

---

### 5. Bitcoin Price: $63,000
- **Action**: $600 worth of Bitcoin sold.
- **Results**:
  - `HPAP` = $65,000.
  - Vatop Group 1:
    - `cVatop` = $100, `cpVatop` = $60,000, `cVact` = $114, `cpVact` = $65,000.
    - `cVactTa` = 0.00174 BTC, `cVactTaa` = $0 BTC, `cVactDa` = $114, `cdVatop` = $14.
  - Vatop Group 2:
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $722, `cpVact` = $65,000.
    - `cVactTa` = 0.01111 BTC, `cVactTaa` = $0 BTC, `cVactDa` = $722, `cdVatop` = $122.
  - Vatop Group 3:
    - `cVatop` = $0, `cpVatop` = $0, `cVact` = $0, `cpVact` = $0.
    - `cVactTa` = $0 BTC, `cVactTaa` = $0 BTC, `cVactDa` = $0, `cdVatop` = $0.
  - Combinations:
    - `acVatops` = $700, `acVacts` = $836.
    - `acVactTas` = 0.01285 BTC, `acVactTaa` = $0 BTC, `acVactDas` = $836.
    - `acdVatops` = $136.
