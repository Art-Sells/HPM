# MASS (Market Automated Supplication System)
MASS or Market Automated Supplication System is a system built under the [HPM](https://github.com/Art-Sells/HPM) that automatically supplicates (or swaps) a native Stablecoin<>Asset in order to ensure losses aren't incured (and profits never lost) during market downswings and profits are always gained during upswings.

## In a Nutshell
MASS is not an aggregate "supplication system" meaning when activated, it does not automatically supplicate all assets into a stablecoin (and vise versa). The reason for this is because profits cannot be gained if MASS were to aggregatetely supplicate assets. In order for to gain the most amounts of profits as possible, MASS (with HPM) activates individually per Vatop Group.

### Example:
***note: see [HPM Mechanics Example](https://github.com/Art-Sells/HPM/blob/main/Mechanics.md#expanded) for acronym meanings.***

1. Bitcoin Price: $60,000
 - $500 worth of Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1
 - - cpVact (or HAP) 1 = $60,000 
 - - cVactTaa 1 = 0.00833
 - Investment Profits & Losses:
 - - ***Profits (acdVatops): $0***
 - - ***Losses: $0***

2. Bitcoin Price: $54,000
 - $600 worth of Bitcoin is purchased/imported
 - HPAP = $60,000
 - Vatop Group 1 ***(MASS activated)***
 - - cpVact (or HAP) 1 = $60,000
 - - cVactTaa 1 = 0
 - - cVactDa 1 = 500 ***(in USD supplicated from BTC)***
 - Vatop Group 2
 - - cpVact (or HAP) 2 = $54,000      
 - - cVactTaa 2 = 0.01111
 - - cVactDa 2 = 0
 - Investment Profits & Losses:
 - - ***Profits (acdVatops): $0***
 - - ***Losses: $0***

3. Bitcoin Price: $65,000 
 - HPAP = $65,000
 - Vatop Group 1 ***(MASS activated)***
 - - cpVact (or HAP) 1 = $65,000       
 - - cVactTaa 1 = 0.00833 ***(in BTC supplicated from USD)***
 - - cVactDa 1 = 0 
 - Vatop Group 2
 - - cpVact (or HAP) 2 = $65,000   
 - - cVactTaa 2 = 0.01111
 - - cVactDa 2 = 0
 - Investment Profits & Losses:
 - - ***Profits (acdVatops): +$164***
 - - ***Losses: $0***

4. Bitcoin Price: $63,000 
 - HPAP = $65,000
 - Vatop Group 1 ***(MASS activated)***
 - - cpVact (or HAP) 1 = $65,000       
 - - cVactTaa 1 = 0
 - - cVactDa 1 = 542 ***(in USD supplicated from BTC)*** 
 - Vatop Group 2 ***(MASS activated)***
 - - cpVact (or HAP) 2 = $65,000   
 - - cVactTaa 2 = 0
 - - cVactDa 2 = $722 ***(in USD supplicated from BTC)***
 - Investment Profits & Losses:
 - - ***Profits (acdVatops): +$164***
 - - ***Losses: $0***

### FAQ (Frequently Asked Question/s):
- What about supplication (swapping) fees?
- - MASS is currently integrating [Polygon POS](https://polygonscan.com/gastracker) into its framework. Polygon POS currently incurs an average ~$0.00016 fee per supplication(swap), this is only 1.6% of $0.01 so it is exorbitantly cheap. So we're working to keep MASS as efficient as possible by decreasing the mount of activations per second/minute/hour per "Vatop Group", so the more Vatop Groups incured in your account, the less often MASS is activated.

#### Efficieny
MASS is currently in Version 1 of production so MASS's base "activation time" increments and decrements based on the amount of assets currently held within Arells so (assuming price changes occur frequently) Fee Constraints and Calculations are in-built into the system.

