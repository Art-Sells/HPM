# HPM Mechanics

### HPAP = Highest Price After Purchase
- Changes based on the highest cpVatop, otherwise 0

### Vatop = Value At Time Of Purchase
- **cVatop** = Corresponding Vatop (the value of your Bitcoin investment at time of purchase/import)
- **cpVatop** = Corresponding Price Vatop (the price of Bitcoin at time of purchase/import)
- **cdVatop** = Corresponding Difference Vatop (cVact - cVatop = cdVatop)
- **acVatops** = All cVatops (Combines all cVatops)
- **acdVatops** = All cdVatops (combines all cdVatops only if positive, otherwise 0)

### Vact = Value At Current Time
- **cVact** = Corresponding Vact (the value of your Bitcoin investment based on the current Bitcoin price, this is updated consistently based on the current Bitcoin price)
- **cVactTa** = cVact Token Amount (reflects the amount of Bitcoin at time of purchase/import)
- **acVacts** = All cVacts (combines all cVacts)
- **acVactTas** = All cVactTas (combines all cVactTas)
- **acVactTaAts** = acVactTa Available To Sell (combines all cVactTas if acVactsAts > 0)
- **acVactsAts** = acVacts Available To Sell (combines cVacts only if the cdVatops > 0)

#### Example:

1. Bitcoin Price: $60,000
 - $500 worth of Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $500
 - - cVactTa 1 = 0.00833 
 - - cdVatop 1 = $0
 - Vatop Group Combinations
 - - acVatops = $500
 - - acVacts = $500
 - - acVactTas = 0.00833
 - - acdVatops = $0
 - - acVactsAts = $0

2. Bitcoin Price: $54,000
 - $600 worth of Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $450 
 - - cVactTa 1 = 0.00833 
 - - cdVatop 1 = -$50
 - Vatop Group 2
 - - cVatop 2 = $600
 - - cpVatop 2 = $54,000
 - - cVact 2 = $600
 - - cVactTa 2 = 0.01111
 - - cdVatop 2 = $0
 - Vatop Group Combinations
 - - acVatops = $1,100
 - - acVacts = $1,050
 - - acVactTas = 0.03052
 - - acdVatops = -$50
 - - acVactsAts = $0

3. Bitcoin Price: $55,000
 - No Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $458
 - - cVactTa 1 = 0.00833 
 - - cdVatop 1 = -$42
 - Vatop Group 2
 - - cVatop 2 = $600
 - - cpVatop 2 = $54,000
 - - cVact 2 = $611
 - - cVactTa 2 = 0.01111
 - - cdVatop 2 = $11
 - Vatop Group Combinations
 - - acVatops = $1,100
 - - acVacts = $1,069
 - - acVactTas = 0.01941
 - - acdVatops = 11
 - - acVactsAts = $611

4. Bitcoin Price: $65,000
 - $200 worth of Bitcoin is purchased/imported
 - HPAP = $65,000
 - Vatop Group 1
 - - cVatop 1 = $500
 - - cpVatop 1 = $60,000
 - - cVact 1 = $542
 - - cVactTa 1 = 0.00833 
 - - cdVatop 1 = $42
 - Vatop Group 2
 - - cVatop 2 = $600
 - - cpVatop 2 = $54,000
 - - cVact 2 = $722
 - - cVactTa 2 = 0.01111
 - - cdVatop 2 = $122
 - Vatop Group 3
 - - cVatop 3 = $200
 - - cVatopTa 3 = 0.00308
 - - cpVatop 3 = $65,000
 - - cVact 3 = $200
 - - cdVatop 3 = $0
 - Vatop Group Combinations
 - - acVatops = $1,300
 - - acVacts = $1,464
 - - acVatopTas = 0.02249
 - - acdVatops = $164 
 - - acVactsAts = $1,264

5. Bitcoin Price: $63,000
 - $650 worth of Bitcoin is sold
 - HPAP = $65,000
 - Vatop Group 1
 - - cVatop 1 = $0
 - - cpVatop 1 = $0
 - - cVact 1 = $0
 - - cVactTa 1 = 0
 - - cdVatop 1 = $0 
 - Vatop Group 2
 - - cVatop 2 = $450
 - - cpVatop 2 = $54,000
 - - cVact 2 = $575
 - - cVactTa 2 = 0.00198
 - - cdVatop 2 = $125 
 - Vatop Group 3 
 - - cVatop 3 = $200
 - - cpVatop 3 = $65,000
 - - cVact 3 = $194
 - - cVactTa 3 = 0.00308
 - - cdVatop 3 = -$6  
 - Vatop Group Combinations
 - - acVatops = $650
 - - acVacts = $769
 - - acVactTas = 0.00506
 - - acdVatops = $119 
 - - acVactsAts = $575 
