# MASS Code Base Architecture 

## Current Version: v1
*(for Bitcoin on Base)*  
***Built with `Typescript` & `Javascript`.***

**Free for any organization or person to use and integrate into their own systems inside or outside Bitcoin.**

*Note: each MASS version is being ever so improved based on feedback and calculation adjustments.*

---

## Supplication Frequency

- **1 supplication every 7 days per `vatopGroup`**.
- **Fee per supplication**: $0.01.
- **Supplications per year per group**: ~52 supplications.

---

## Algorithm:

### 1. Fetch Groups:
- Fetch `vatopGroups` dynamically without fixed intervals.

### 2. Dynamic Supplication Triggers:
- Based on changes to `vatopGroups`:
  - Trigger `supplicateUSDCintoWBTC` if:
    - `cVactTaa > 0.00001`.
    - New `cVactTaa` > Previous `cVactTaa`.
    - The last supplication for the `vatopGroup` was at least **7 days ago**.
  - Trigger `supplicateWBTCintoUSDC` if:
    - `cVactDa > 0.01`.
    - New `cVactDa` > Previous `cVactDa`.
    - The last supplication for the `vatopGroup` was at least **7 days ago**.

### 3. Fee Deduction:
- Deduct fees primarily from `cVact`.
- Halt supplications if `cVact` drops below the **safeguard threshold** (e.g., retaining 99.99% of `cVact`).

### 4. Adjust for Added/Deleted Groups:
- If `vatopGroups` are added or deleted:
  - Skip supplication logic until the next cycle.
  - Update `prevVatopGroups` for accurate comparisons.

---

## Example Outputs:

### Case 1: `cdVatop = 0.01`
- **Supplications Per Year per Group**: ~52.
- **Trigger Logic**: Supplications occur as long as `cdVatop >= 0.009` and at least 7 days have passed since the last supplication.

### Case 2: `cdVatop = 0.2`
- **Supplications Per Year per Group**: ~52.
- **Trigger Logic**: Supplications resume dynamically when `vatopGroups` change and at least 7 days have passed.

---

## Code Explanation:

1. **Fetching Groups**:
   - Groups are fetched dynamically based on user activity.
   - No fixed intervals for fetching or supplicating.

2. **Dynamic Supplications**:
   - Supplications are triggered based on `useEffect` monitoring `vatopGroups` for changes.
   - Each `vatopGroup` can have only one supplication per **7 days**.

---

⚠️ **Note:** This repository should not be considered production-ready. It is a **sandbox for innovation**, where experiments are intentionally pushed beyond conventional assumptions.
