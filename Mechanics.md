# HPM Mechanics

## [Code Base Architecture](https://github.com/Art-Sells/HPM/tree/main/HPMCodeBase)

## In a Nutshell:
If you purchase/import Bitcoin into Arells at $60k (for example), the HPM holds the price for you and automatically swaps your Bitcoin into a native Stablecoin thanks to a new system called **MASS(Market Automated Supplication System)**; this is also achieved if the Bitcoin price falls lower than $60k.

Then, once (or if) the Bitcoin price rises over $60k, MASS swaps the native Stablecoin back into Bitcoin, this way, you’re consistently riding up profits during bull markets, and never experiencing losses during bear markets (without even having to think about it).

It gets even better…

If Bitcoin rises above the price you imported/purchased ($60k in this instance) to $65k then falls to $63k, the $65k price is held. This means, you will never lose any profits you made on the upswing when the downswing occurs (even if the Bitcoin price drops to $0 thanks to MASS).

***HPM & MASS in action: [arells.com/concept](https://arells.com/concept)***

## Expanded:

### HPAP = Highest Price After Purchase
- Changes based on the highest cpVact, otherwise 0

### HAP = Highest Asset Price
- The same value as the cpVact

### Vatop = Value At Time Of Purchase
- **cVatop** = Corresponding Vatop (the value of your Bitcoin investment at time of purchase/import)
- **cpVatop** = Corresponding Price Vatop (the price of Bitcoin at time of purchase/import)
- **cdVatop** = Corresponding Difference Vatop (cVact - cVatop = cdVatop)
- **acVatops** = All cVatops (Combines all cVatops)
- **acdVatops** = All cdVatops (combines all cdVatops only if positive, otherwise 0)

### Vact = Value At Current Time
- **cVact** = Corresponding Vact (equals the cVatop in the beginning and increases based on the cpVact)
- **cpVact** = Corresponding Price Vact (equals the cpVatop in the beginning and increases based on the HAP)
- **cVactTa** = cVact Token Amount (reflects the amount of Bitcoin at time of purchase/import and is swapped for the cVactDa if cdVatop >= 0)
- **cVactDa** = cVact Dollar Amount (reflects the Dollar Amount regarding the cVact and is swapped for the cVactTa if cdVatop > 0)
- **acVacts** = All cVacts (combines all cVacts)
- **acVactTas** = All cVactTas (combines all cVactTas)
- **acVactDas** = All cVactDas (combines all cVactDas)

#### Example:

1. Bitcoin Price: $60,000
 - $500 worth of Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $500
 - - cpVact (or HAP) 1 = $60,000 
 - - cVactTa 1 = 0
 - - cVactDa 1 = 500
 - - cdVatop 1 = $0
 - Vatop Group Combinations
 - - acVatops = $500
 - - acVacts = $500
 - - acVactTas = 0.00833
 - - acdVatops = $0
 - - acVactsDas = $500

2. Bitcoin Price: $54,000
 - $600 worth of Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $500
 - - cpVact (or HAP) 1 = $60,000      
 - - cVactTa 1 = 0.00833
 - - cVactDa 1 = 500
 - - cdVatop 1 = $0
 - Vatop Group 2
 - - cVatop 2 = $600
 - - cpVatop 2 = $54,000
 - - cVact 2 = $600
 - - cpVact (or HAP) 2 = $54,000      
 - - cVactTa 2 = 0.01111
 - - cVactDa 2 = 600 
 - - cdVatop 2 = $0
 - Vatop Group Combinations
 - - acVatops = $1,100
 - - acVacts = $1,100
 - - acVactTas = 0.01941
 - - acdVatops = $0
 - - acVactsDas = 1,100

3. Bitcoin Price: $55,000
 - No Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $500
 - - cpVact (or HAP) 1 = $60,000      
 - - cVactTa 1 = 0.00833
 - - cVactDa 1 = 500
 - - cdVatop 1 = $0
 - Vatop Group 2
 - - cVatop 2 = $600
 - - cpVatop 2 = $54,000
 - - cVact 2 = $611
 - - cpVact (or HAP) 2 = $55,000      
 - - cVactTa 2 = 0.01111
 - - cVactDa 2 = 0     
 - - cdVatop 2 = $11
 - Vatop Group Combinations
 - - acVatops = $1,100
 - - acVacts = $1,111
 - - acVactTas = 0.01941
 - - acdVatops = 11
 - - acVactsDas = 0

4. Bitcoin Price: $65,000
 - $200 worth of Bitcoin is purchased/imported
 - HPAP = $65,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $542
 - - cpVact (or HAP) 1 = $65,000       
 - - cVactTa 1 = 0.00833
 - - cVactDa 1 = 0
 - - cdVatop 1 = $42
 - Vatop Group 2
 - - cVatop 2 = $600
 - - cpVatop 2 = $54,000
 - - cVact 2 = $722
 - - cpVact (or HAP) 2 = $65,000   
 - - cVactTa 2 = 0.01111
 - - cVactDa 2 = 0
 - - cdVatop 2 = $122
 - Vatop Group 3
 - - cVatop 3 = $200
 - - cpVatop 3 = $65,000
 - - cVact 3 = $200
 - - cpVact (or HAP) 3 = $65,000
 - - cVatopTa 3 = 0.00308
 - - cVactDa 3 = 200
 - - cdVatop 3 = $0
 - Vatop Group Combinations
 - - acVatops = $1,300
 - - acVacts = $1,464
 - - acVatopTas = 0.02249
 - - acdVatops = $164 
 - - acVactsDas = 200

5. Bitcoin Price: $63,000
 - $650 worth of Bitcoin is sold
 - HPAP = $65,000
 - Vatop Group 1
 - - cVatop 1 = $0
 - - cpVatop 1 = $0
 - - cVact 1 = $0
 - - cpVact (or HAP) 1 = $0     
 - - cVactTa 1 = 0
 - - cVactDa 1 = 0
 - - cdVatop 1 = $0
 - Vatop Group 2
 - - cVatop 2 = $450
 - - cpVatop 2 = $54,000
 - - cVact 2 = $614
 - - cpVact (or HAP) 2 = $65,000 
 - - cVactTa 2 = 0.00198
 - - cVactDa 2 = 0
 - - cdVatop 2 = $164 
 - Vatop Group 3 
 - - cVatop 3 = $200
 - - cpVatop 3 = $65,000
 - - cVact 3 = $200
 - - cpVact (or HAP) 3 = $65,000 
 - - cVactTa 3 = 0.00308
 - - cVactDa 3 = 200
 - - cdVatop 3 = $0  
 - Vatop Group Combinations
 - - acVatops = $650
 - - acVacts = $814
 - - acVactTas = 0.00506
 - - acdVatops = $164 
 - - acVactsDas = 200
