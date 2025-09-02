# HPM Mechanics 

## [Code Base Architecture](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase)

### In Action: [arells.com/concept](https://arells.com/concept)

## In a Nutshell:
If you purchase/import an asset from Arells at $60k (for example), HPM holds your investment at that price (should the asset price decline) ensuring your investments are bear-market immune thanks to a new system called ***[MASS (Market Automated Supplication System)](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS)***. This protection applies if the asset price falls lower than $60k. Then, once (or if) the asset price rises over $60k, MASS is activated. This way, you’re consistently riding profits during bull markets, and rarely (if ever) experiencing losses during bear markets (without ever having to think about it).

It gets even better…

If the asset rises above the price you imported/purchased ($60k in this instance) to $65k, then falls to $63k, the $65k price is recorded (or *held*). This means bear-market dynamics that typically cause tremendous investment losses are hampered when price downswings occur (even if the asset price drops to $0 thanks to MASS).

***With Arells, you set your investments and forget them (without worrying about bear-market losses).***

This is more succinctly described and reflected by ***[LPP](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase/MASS/LPP)***.

## Terminology and Calculations *(currently in the process of being upgraded to fit LPP v1)*:

### HPAP = Highest Price After Purchase
- The highest `cpVact` across all groups. Defaults to 0 if no groups exist.

### HAP = Highest Asset Price
- The same value as the `cpVact` for each VatopGroup.

---

### Vatop = Value At Time Of Purchase
- **cVatop**: Value of the asset investment at the time of purchase or import.  
- **cpVatop**: Asset price at the time of purchase or import.  
- **cdVatop**: Difference between `cVact` and `cVatop`: cdVatop = cVact - cVatop.  
- **acVatops**: Sum of all `cVatop` values across VatopGroups.  
- **acdVatops**: Sum of all positive `cdVatop` values; negative values are excluded.  

---

### Vact = Value At Current Time
- **cVact**: Current value of the asset investment, which starts as `cVatop` and increases as `cpVact` grows.  
- **cpVact**: Current price of the asset; begins as `cpVatop` and adjusts based on the highest asset price observed (`HAP`).  
- **cVactTaa**: Token amount of the asset available to supplicate for dollars. If the current asset price (`AssetPrice`) is less than `cpVact`, this triggers MASS orchestration.  
- **cVactDa**: Dollar amount available to supplicate for the asset. If the current asset price (`AssetPrice`) is greater or equal to `cpVact`, this also triggers MASS orchestration.  
- **acVacts**: Sum of all `cVact` values across VatopGroups.  
- **acVactTaa**: Sum of all `cVactTaa` values across VatopGroups.  
- **acVactDas**: Sum of all `cVactDa` values across VatopGroups.  

---

## Example Scenarios (without LPP integrations):

### 1. Asset Price: $60,000
- **Action**: $500 worth of the asset purchased/imported.  
- **Results**:  
  - `HPAP` = $60,000.  
  - Vatop Group 1:  
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $500, `cpVact` = $60,000.  
    - `cVactTaa` = 0.00833 Tokens, `cVactDa` = $0, `cdVatop` = $0.  
  - Combinations:  
    - `acVatops` = $500, `acVacts` = $500.  
    - `acVactTaa` = 0.00833 Tokens, `acVactDas` = $0.  
    - `acdVatops` = $0.  

---

### 2. Asset Price: $54,000
- **Action**: $600 worth of the asset purchased/imported.  
- **Results**:  
  - `HPAP` = $60,000.  
  - Vatop Group 1:  
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $500, `cpVact` = $60,000.  
    - `cVactTaa` = 0 Tokens, `cVactDa` = $500, `cdVatop` = $0.  
  - Vatop Group 2:  
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $600, `cpVact` = $54,000.  
    - `cVactTaa` = 0.01111 Tokens, `cVactDa` = $0, `cdVatop` = $0.  
  - Combinations:  
    - `acVatops` = $1,100, `acVacts` = $1,100.  
    - `acVactTaa` = 0.01111 Tokens, `acVactDas` = $500.  
    - `acdVatops` = $0.  

---

### 3. Asset Price: $55,000
- **Action**: No asset purchased/imported.  
- **Results**:  
  - `HPAP` = $60,000.  
  - Vatop Group 1:  
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $500, `cpVact` = $60,000.  
    - `cVactTaa` = 0 Tokens, `cVactDa` = $500, `cdVatop` = $0.  
  - Vatop Group 2:  
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $611, `cpVact` = $55,000.  
    - `cVactTaa` = 0.01111 Tokens, `cVactDa` = $0, `cdVatop` = $11.  
  - Combinations:  
    - `acVatops` = $1,100, `acVacts` = $1,111.  
    - `acVactTaa` = 0.01111 Tokens, `acVactDas` = $500.  
    - `acdVatops` = $11.  

---

### 4. Asset Price: $65,000
- **Action**: $200 worth of the asset purchased/imported.  
- **Results**:  
  - `HPAP` = $65,000.  
  - Vatop Group 1:  
    - `cVatop` = $500, `cpVatop` = $60,000, `cVact` = $542, `cpVact` = $65,000.  
    - `cVactTaa` = 0.00833 Tokens, `cVactDa` = $0, `cdVatop` = $42.  
  - Vatop Group 2:  
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $722, `cpVact` = $65,000.  
    - `cVactTaa` = 0.01111 Tokens, `cVactDa` = $0, `cdVatop` = $122.  
  - Vatop Group 3:  
    - `cVatop` = $200, `cpVatop` = $65,000, `cVact` = $200, `cpVact` = $65,000.  
    - `cVactTaa` = 0.00308 Tokens, `cVactDa` = $0, `cdVatop` = $0.  
  - Combinations:  
    - `acVatops` = $1,300, `acVacts` = $1,464.  
    - `acVactTaa` = 0.02252 Tokens, `acVactDas` = $0.  
    - `acdVatops` = $164.  

---

### 5. Asset Price: $63,000
- **Action**: $600 worth of the asset sold.  
- **Results**:  
  - `HPAP` = $65,000.  
  - Vatop Group 1:  
    - `cVatop` = $100, `cpVatop` = $60,000, `cVact` = $114, `cpVact` = $65,000.  
    - `cVactTaa` = 0 Tokens, `cVactDa` = $114, `cdVatop` = $14.  
  - Vatop Group 2:  
    - `cVatop` = $600, `cpVatop` = $54,000, `cVact` = $722, `cpVact` = $65,000.  
    - `cVactTaa` = 0 Tokens, `cVactDa` = $722, `cdVatop` = $122.  
  - Vatop Group 3:  
    - `cVatop` = $0, `cpVatop` = $0, `cVact` = $0, `cpVact` = $0.  
    - `cVactTaa` = 0 Tokens, `cVactDa` = $0, `cdVatop` = $0.  
  - Combinations:  
    - `acVatops` = $700, `acVacts` = $836.  
    - `acVactTaa` = 0 Tokens, `acVactDas` = $836.  
    - `acdVatops` = $136.  
