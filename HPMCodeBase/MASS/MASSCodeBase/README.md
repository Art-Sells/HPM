# MASS Code Base Architecture (version 1) *(for Bitcoin)*

***Built with React (typescript).***

**Free for any organization or person to use and integrate into their own systems inside or outside Bitcoin.**

## Fee Constraints/Calculations

### 1. Fee Constraints:
- For `cdVatop = 0.00`, ensure the **max annual fee** does not exceed $0.10.
- For `cdVatop <= 0.01`, allow **unlimited swaps** until `cdVatop` decreases below `0.009`.
- If `cdVatop > 0.01`, adjust fee impact dynamically to scale with `cdVatop` growth, reducing perceived fee effects.
________________________

### 2. Fee Calculation:
- **Fee per swap**: $0.00016 (based on current (date: 11/30/24) Polygon POS Gwei).
- **Number of swaps per year**:
  - Swaps Per Year = Max Annual Fee ÷ Fee Per Swap

Example:
- For a $0.10 max annual fee:
  - Swaps Per Year = 0.10 ÷ 0.00016 = **625 swaps/year**.
________________________

### 3. Dynamic Interval:
- **Interval per group**:
  - Interval (seconds) = Seconds Per Year ÷ Swaps Per Year

Example:
- For 625 swaps/year:
  - Interval = (365 × 24 × 60 × 60) ÷ 625 ≈ **50,457 seconds (~14 hours)**.
________________________

### 4. Unlimited Swaps:
- If `cdVatop <= 0.01`:
  - Max annual fee = Infinity.
  - Minimum interval capped at **10 seconds** to allow frequent swaps.
________________________

### 5. Adjusting for `cdVatop` Growth:
- If `cdVatop` grows significantly (e.g., from 0.1 to 0.2):
  - Dynamically scale `maxAnnualFee` to reduce the relative impact of fees.
  - Formula:
    - Max Annual Fee = Fee Per Swap × Min(500, `cdVatop` × 1000)

Example:
- For `cdVatop = 0.2`:
  - Max Annual Fee = 0.00016 × Min(500, 0.2 × 1000) = **$0.08/year**.
________________________

## Algorithm:

### 1. Fetch and Filter Groups:
- Fetch `VatopGroups` and filter:
  - Remove groups with invalid or zero values:
    - `cVatop = 0`, `cVact = 0`, `cVactTa = 0`, and `cdVatop = 0`.
  - Only keep groups where **at least one value** is active.

### 2. Calculate Max Swaps per Group:
- Based on:
  - `cdVatop` growth.
  - Fee constraints.

### 3. Determine Intervals per Group:
- For `cdVatop <= 0.01`:
  - Unlimited swaps with a **minimum interval of 10 seconds**.
- For `cdVatop > 0.01`:
  - Dynamically adjust intervals to respect the scaled `maxAnnualFee`.

### 4. Adjust for Added/Deleted Groups:
- If `VatopGroups` are added or deleted:
  - Skip swap logic until the next cycle.
  - Update `prevVatopGroups` for accurate comparisons.

### 5. Swap Conditions:
- For each group:
  - Trigger `swapUSDCintoWBTC` if:
    - `cVactTaa > 0.00001`.
    - New `cVactTaa` > Previous `cVactTaa`.
  - Trigger `swapWBTCintoUSDC` if:
    - `cVactDa > 0.01`.
    - New `cVactDa` > Previous `cVactDa`.

________________________

## Example Outputs:

### Case 1: `cdVatop = 0.01`
- **Max Annual Fee**: Infinity.
- **Swaps Per Year**: Unlimited.
- **Interval**: **10 seconds** (minimum cap).

### Case 2: `cdVatop = 0.2`
- **Max Annual Fee**: $0.08 (scaled dynamically).
- **Swaps Per Year**: 0.08 ÷ 0.00016 = **500 swaps/year**.
- **Interval**: (365 × 24 × 60 × 60) ÷ 500 ≈ **1,577 seconds (~26 minutes)**.

### Case 3: `cdVatop = 0.0`
- Group is removed due to invalid values.
________________________

### Code Explanation:

1. **Fetching Groups**:
   - Groups are fetched and filtered to remove inactive ones (`cVatop = 0`, `cVact = 0`, etc.).

2. **Dynamic Swaps**:
   - Unlimited swaps for `cdVatop <= 0.01` with intervals capped at **10 seconds**.
   - Dynamically scale fees for `cdVatop > 0.01`.

3. **State Management**:
   - Preserve `prevVatopGroups` to track changes and trigger swaps appropriately.

4. **Swap Logic**:
   - Swaps are triggered based on changes in `cVactTaa` or `cVactDa`.
   - Added/deleted groups skip swaps temporarily to ensure state accuracy.

## Smart Contract *(coming soon)*
