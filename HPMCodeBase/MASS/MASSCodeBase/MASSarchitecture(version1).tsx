'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { fetchUserAttributes } from 'aws-amplify/auth';
import axios from 'axios';

interface MASSarchitectureType {
  cVactTaa: number;
  cVactDa: number;
}

interface VatopGroup {
  cVatop: number;
  cpVatop: number;
  cVact: number;
  cpVact: number;
  cVactTa: number;
  cVactDa: number;
  cVactTaa: number;
  cdVatop: number;
}

const MASSarchitecture = createContext<MASSarchitectureType | undefined>(undefined);

export const MASSProvider = ({ children }: { children: ReactNode }) => {
  const [email, setEmail] = useState<string>('');
  const [vatopGroups, setVatopGroups] = useState<VatopGroup[]>([]);
  const [prevVatopGroups, setPrevVatopGroups] = useState<VatopGroup[]>([]);
  const [swapIntervalIds, setSwapIntervalIds] = useState<NodeJS.Timeout[]>([]);

  const FEE_PER_SWAP = 0.00016; // $0.00016 per swap
  const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
  const MIN_INTERVAL = 10; // Minimum interval capped at 10 seconds

  useEffect(() => {
    const fetchEmail = async () => {
      try {
        const attributesResponse = await fetchUserAttributes();
        const emailAttribute = attributesResponse.email;
        if (emailAttribute) {
          setEmail(emailAttribute);
        }
      } catch (error) {
        console.error('Error fetching user attributes:', error);
      }
    };
    fetchEmail();
  }, []);

  useEffect(() => {
    if (!email) return;

    const fetchVatopGroups = async () => {
      try {
        const response = await axios.get('/api/fetchVatopGroups', { params: { email } });
        const fetchedVatopGroups = response.data.vatopGroups || [];

        const uniqueVatopGroups = fetchedVatopGroups.filter(
          (group: VatopGroup, index: number, self: VatopGroup[]) =>
            index === self.findIndex((g) => g.cpVatop === group.cpVatop && g.cVactTa === group.cVactTa)
        );

        setVatopGroups(uniqueVatopGroups);
        adjustSwaps(uniqueVatopGroups); // Dynamically adjust swaps
      } catch (error) {
        console.error('Error fetching vatop groups:', error);
      }
    };

    const intervalId = setInterval(fetchVatopGroups, MIN_INTERVAL * 1000);
    fetchVatopGroups();

    return () => clearInterval(intervalId);
  }, [email]);

  const adjustSwaps = (groups: VatopGroup[]) => {
    swapIntervalIds.forEach((id) => clearInterval(id));
    setSwapIntervalIds([]);

    const newIntervalIds: NodeJS.Timeout[] = [];

    groups.forEach((group) => {
      const prevCdVatop = prevVatopGroups.find((prevGroup) => prevGroup.cpVatop === group.cpVatop)?.cdVatop || 0;
      const currentCdVatop = group.cdVatop;

      // Determine fee behavior based on cdVatop
      let maxAnnualFee;
      if (currentCdVatop <= 0.01) {
        // Allow unlimited swaps if cdVatop <= 0.01
        maxAnnualFee = Infinity;
        console.log(
          `Group ${group.cpVatop}: cdVatop=${currentCdVatop}, enabling unlimited swaps.`
        );
      } else if (prevCdVatop > 0 && currentCdVatop > prevCdVatop) {
        // For growing cdVatop, reduce fee impact dynamically
        maxAnnualFee = FEE_PER_SWAP * Math.min(500, currentCdVatop * 1000); // Example scaling logic
        console.log(
          `Group ${group.cpVatop}: cdVatop=${currentCdVatop}, scaling max fee dynamically.`
        );
      } else {
        maxAnnualFee = 0.10; // Default to $0.10/year for other cases
      }

      const maxSwapsPerYear = maxAnnualFee === Infinity
        ? SECONDS_PER_YEAR / MIN_INTERVAL
        : Math.floor(maxAnnualFee / FEE_PER_SWAP);
      const calculatedInterval = maxAnnualFee === Infinity
        ? MIN_INTERVAL
        : Math.floor(SECONDS_PER_YEAR / maxSwapsPerYear);
      const interval = Math.max(calculatedInterval, MIN_INTERVAL);

      console.log(
        `Group ${group.cpVatop}: cdVatop=${currentCdVatop}, Max Fee=${maxAnnualFee}, Max Swaps/Year=${maxSwapsPerYear}, Interval=${interval}s`
      );

      const intervalId = setInterval(() => {
        console.log(`Running swap for group ${group.cpVatop}`);
        // Add your swap logic here
      }, interval * 1000);

      newIntervalIds.push(intervalId);
    });

    setSwapIntervalIds(newIntervalIds);
  };

  useEffect(() => {
    const prevIds = prevVatopGroups.map((group) => group.cpVatop);
    const currentIds = vatopGroups.map((group) => group.cpVatop);

    const addedGroups = vatopGroups.filter((group) => !prevIds.includes(group.cpVatop));
    const deletedGroups = prevVatopGroups.filter((group) => !currentIds.includes(group.cpVatop));

    if (addedGroups.length > 0 || deletedGroups.length > 0) {
      console.log('Groups were added or deleted, skipping swaps.');
      setPrevVatopGroups([...vatopGroups]);
      return;
    }

    vatopGroups.forEach((group, index) => {
      const prevGroup = prevVatopGroups[index] || {};

      if (group.cVactTaa > 0.00001 && (!prevGroup.cVactTaa || group.cVactTaa > prevGroup.cVactTaa)) {
        console.log(`Initiating USDC to WBTC swap for amount: ${group.cVactTaa}`);
        swapUSDCintoWBTC(group.cVactTaa);
      }

      if (group.cVactDa > 0.01 && (!prevGroup.cVactDa || group.cVactDa > prevGroup.cVactDa)) {
        console.log(`Initiating WBTC to USDC swap for amount: ${group.cVactDa}`);
        swapWBTCintoUSDC(group.cVactDa);
      }
    });

    setPrevVatopGroups([...vatopGroups]);
  }, [vatopGroups]);

  const swapUSDCintoWBTC = async (amount: number) => {
    console.log(`Swapping ${amount} USDC to WBTC`);
    // Logic for USDC to WBTC swap
  };

  const swapWBTCintoUSDC = async (amount: number) => {
    console.log(`Swapping ${amount} WBTC to USDC`);
    // Logic for WBTC to USDC swap
  };

  return (
    <MASSarchitecture.Provider value={{ cVactTaa: 0, cVactDa: 0 }}>
      {children}
    </MASSarchitecture.Provider>
  );
};

export const useMASS = () => {
  const context = useContext(MASSarchitecture);
  if (!context) {
    throw new Error('useMASS must be used within a MASSProvider');
  }
  return context;
};
