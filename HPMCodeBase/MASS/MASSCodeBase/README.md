# MASS Code Base Architecture *(for Bitcoin)*

***Built with `Typescript` `Solidity` & `Javascript`.***

**Free for any organization or person to use and integrate into their own systems inside or outside Bitcoin.**

*Note: each MASS version is being ever so improved based on feedback and fee constrains and calculation arbitrations and differences.*

## Fee Constraints/Calculations

### 1. Fee Constraints:
- For `cdVatop = 0.00`, ensure the **max annual fee** does not exceed $0.10.
- For `cdVatop <= 0.01`, allow **unlimited supplications** until `cdVatop` decreases below `0.009`.
- If `cdVatop > 0.01`, adjust fee impact dynamically to scale with `cdVatop` growth, reducing perceived fee effects.
________________________

### 2. Fee Calculation:
- **Fee per supplication**: $0.00016 (based on current (date: 11/30/24) Polygon POS Gwei).
- **Number of supplications per year**:
  - Supplications Per Year = Max Annual Fee ÷ Fee Per Supplication

Example:
- For a $0.10 max annual fee:
  - Supplications Per Year = 0.10 ÷ 0.00016 = **625 supplications/year**.
________________________

### 3. Dynamic Trigger Logic:
- Supplications are dynamically triggered based on changes to `vatopGroups`:
  - Additions or deletions of groups cause supplications to pause temporarily for synchronization.
  - Supplications are resumed when:
    - `cVactTaa` increases above `0.00001`.
    - `cVactDa` increases above `0.01`.
________________________

### 4. Unlimited Supplications:
- If `cdVatop <= 0.01`:
  - Unlimited supplications are allowed as long as:
    - The fee deduction keeps `cdVatop >= 0.009`.
    - Fees are deducted primarily from `cVact`.

________________________

### 5. Adjusting for `cdVatop` Growth:
- If `cdVatop` grows significantly (e.g., from 0.1 to 0.2):
  - Dynamically scale fees for less impact relative to profits (`cdVatop` growth).
  - Formula:
    - Max Annual Fee = Fee Per Supplication × Min(500, `cdVatop` × 1000)

Example:
- For `cdVatop = 0.2`:
  - Max Annual Fee = 0.00016 × Min(500, 0.2 × 1000) = **$0.08/year**.
________________________

## Algorithm:

### 1. Fetch Groups:
- Fetch `vatopGroups` dynamically without fixed intervals.

### 2. Dynamic Supplication Triggers:
- Based on changes to `vatopGroups`:
  - Trigger `supplicateUSDCintoWBTC` if:
    - `cVactTaa > 0.00001`.
    - New `cVactTaa` > Previous `cVactTaa`.
  - Trigger `supplicateWBTCintoUSDC` if:
    - `cVactDa > 0.01`.
    - New `cVactDa` > Previous `cVactDa`.

### 3. Fee Deduction:
- Deduct fees primarily from `cVact`:
  - Halt supplications if `cVact` drops below the **safeguard threshold** (e.g., retaining 99.99% of `cVact`).

### 4. Adjust for Added/Deleted Groups:
- If `vatopGroups` are added or deleted:
  - Skip supplication logic until the next cycle.
  - Update `prevVatopGroups` for accurate comparisons.

________________________

## Example Outputs:

### Case 1: `cdVatop = 0.01`
- **Max Annual Fee**: Infinity.
- **Supplications Per Year**: Unlimited.
- **Trigger Logic**: Supplications occur as long as `cdVatop >= 0.009`.

### Case 2: `cdVatop = 0.2`
- **Max Annual Fee**: $0.08 (scaled dynamically).
- **Supplications Per Year**: 0.08 ÷ 0.00016 = **500 supplications/year**.
- **Trigger Logic**: Supplications resume dynamically when `vatopGroups` change.
________________________

### Code Explanation:

1. **Fetching Groups**:
   - Groups are fetched dynamically based on user activity.
   - No fixed intervals for fetching or supplicating.

2. **Dynamic Supplications**:
   - Supplications are triggered based on `useEffect` monitoring `vatopGroups` for changes.
   - Unlimited supplications are allowed for `cdVatop <= 0.01`.

3. **State Management**:
   - Synchronize `prevVatopGroups` to track changes and trigger supplications appropriately.

4. **Supplication Logic**:
   - Supplications are wrapped within the `handleSupplications` function to handle fee deduction and safeguards.
   - Only trigger supplications when conditions are met.
