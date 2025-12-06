# Vavity (version 1)

If you import your investment asset at an external asset price per token at $60k (for example), Vavity autonomously anchors your investment at that price (should the asset price decline) ensuring your investments are bear-market immune. And should the asset price increase, Vavity's anchored pricing system (VAPA) lifts so you ride profits on upswings and protect those profits during downswings.

***With Vavity, you set your investments and forget them (without worrying about bear-market losses).***

## Terminologies:

**VAPA** = Valued Asset Price Anchored

- The highest valued asset price anchored. Defaults to external price if no assets exist.

**Vatoi** = Value At Time Of Import

- `cVatoi`: Value of the asset investment at the time of import.
- `cpVatoi`: Asset price at the time of import.
- `cdVatoi`: Difference between `cVact` and `cVatoi`: `cdVatoi = cVact - cVatoi`.
- `acVatoi`: Combination of all the `cVatoi`s.
- `acdVatoi`: Combination of all the `cdVatoi`s.

**Vact** = Value At Current Time

- `cVact`: Current value of the asset investment, which starts as `cVatoi` and increases as `cpVact` grows. `cVact` = `cVactTaa`*`cpVact`.
- `cpVact`: Current price of the asset; begins as `cpVatoi` and adjusts based on the highest asset price observed (VAPA).
- `cVactTaa`: Token amount of the asset available.
- `acVact`: Combination of all `cVact`s.
- `acVactTaa`: Combination of all `cVactTaa`s.

---

## Calculation Scenarios:

### 1. External asset price: $60,000

- **Action:** $500 worth of the external asset investment imported.
- **Results:**
  - **VAPA** = $60,000.
    - Wallet 1:
      - `cVatoi` = $500, `cpVatoi` = $60,000, `cVact` = $500, `cpVact` = $60,000.
      - `cVactTaa` = 0.00833 Tokens `cdVatoi` = $0.
    - Wallet Totals:
      - `acVatoi` = $500
      - `acdVatoi` = $0
      - `acVact` = $500
      - `acVactTaa` = 0.00833

### 2. External asset price falls: $54,000

- **Action:** $600 worth of the external asset investment imported.
- **Results:**
  - **VAPA** = $60,000.
    - Wallet 1:
      - `cVatoi` = $1,166, `cpVatoi` = $60,000, `cVact` = $1,166, `cpVact` = $60,000.
      - `cVactTaa` = 0.01944, `cdVatoi` = $0.
    - Wallet Totals:
      - `acVatoi` = $1,166
      - `acdVatoi` = $0
      - `acVact` = $1,166
      - `acVactTaa` = 0.01944


### 4. External asset price rises: $65,000

- **Results:**
  - **VAPA** = $65,000.
    - Wallet 1:
      - `cVatoi` = $1,166, `cpVatoi` = $60,000, `cVact` = $1,263, `cpVact` = $65,000.
      - `cVactTaa` = 0.01944, `cdVatoi` = $97.
    - Wallet Totals:
      - `acVatoi` = $1,166
      - `acdVatoi` = $97
      - `acVact` = $1,263
      - `acVactTaa` = 0.01944

### 4. External asset price falls: $63,000

- **Results:**
  - **VAPA** = $65,000.
    - Wallet 1:
      - `cVatoi` = $1,166, `cpVatoi` = $60,000, `cVact` = $1,263, `cpVact` = $65,000.
      - `cVactTaa` = 0.01944, `cdVatoi` = $97.
    - Wallet Totals:
      - `acVatoi` = $1,166
      - `acdVatoi` = $97
      - `acVact` = $1,263
      - `acVactTaa` = 0.01944

### 5. External asset price falls: $50,000

- **Action:** New Wallet created and $200 worth of the external asset investment imported.
- **Results:**
  - **VAPA** = $65,000.
    - Wallet 1:
      - `cVatoi` = $1,166, `cpVatoi` = $60,000, `cVact` = $1,263, `cpVact` = $65,000.
      - `cVactTaa` = 0.01944, `cdVatoi` = $97.
    - Wallet 2:
      - `cVatoi` = $260, `cpVatoi` = $65,000, `cVact` = $260, `cpVact` = $65,000.
      - `cVactTaa` = 0.004, `cdVatoi` = $0.
    - Wallet Totals:
      - `acVatoi` = $1,426 ($1,166 + $260)
      - `acdVatoi` = $97 ($97 + $0)
      - `acVact` = $1,523 ($1,263 + $260)
      - `acVactTaa` = 0.02344 (0.01944 + 0.004)
