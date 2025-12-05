'use client';

import { useUser } from './UserContext';
import axios from 'axios';
import React, { createContext, useContext, useState, useEffect } from 'react';
import { fetchBitcoinPrice, setManualBitcoinPrice as setManualBitcoinPriceApi } from '../lib/coingecko-api';
import { fetchUserAttributes } from 'aws-amplify/auth';

interface VatoiState {
  cVatoi: number; // Value of the asset investment at the time of import
  cpVatoi: number; // Asset price at the time of import
  cdVatoi: number; // Difference between cVact and cVatoi: cdVatoi = cVact - cVatoi
}

interface VactState {
  cVact: number; // Current value of the asset investment
  cpVact: number; // Current price of the asset (VAPA)
  cVactTaa: number; // Token amount of the asset available
}

interface VavityarchitectureType {
  bitcoinPrice: number;
  vatoi: VatoiState;
  vact: VactState;
  vapa: number; // Valued Asset Price Anchored (highest cpVact)
  importAmount: number;
  exportAmount: number;
  setImportAmount: (amount: number) => void;
  setExportAmount: (amount: number) => void;
  handleImport: (amount: number) => void;
  handleImportABTC: (amount: number) => void;
  handleExport: (amount: number) => void;
  setManualBitcoinPrice: (price: number | ((currentPrice: number) => number)) => void;
  exportedAmounts: number;
  email: string;
  readABTCFile: () => Promise<number | null>;
  updateABTCFile: (amount: number) => Promise<number>;
}

const Vavityarchitecture = createContext<VavityarchitectureType | undefined>(undefined);

export const VavityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [email, setEmail] = useState<string>('');
  const [bitcoinPrice, setBitcoinPrice] = useState<number>(60000);
  const [importAmount, setImportAmount] = useState<number>(0);
  const [exportAmount, setExportAmount] = useState<number>(0);
  const [exportedAmounts, setExportedAmounts] = useState<number>(0);
  
  // Single aggregated state instead of groups
  const [vatoi, setVatoi] = useState<VatoiState>({
    cVatoi: 0,
    cpVatoi: 0,
    cdVatoi: 0,
  });

  const [vact, setVact] = useState<VactState>({
    cVact: 0,
    cpVact: 0,
    cVactTaa: 0,
  });

  const [vapa, setVapa] = useState<number>(60000);

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
    const fetchVatoiState = async () => {
      try {
        if (!email) {
          console.warn('No email provided, skipping fetchVatoiState');
          return;
        }
  
        const response = await axios.get('/api/fetchVatoiState', { params: { email } });
        const fetchedVatoi = response.data.vatoi || { cVatoi: 0, cpVatoi: 0, cdVatoi: 0 };
        const fetchedVact = response.data.vact || { cVact: 0, cpVact: 0, cVactTaa: 0 };
        const fetchedVapa = response.data.vapa || bitcoinPrice;
        const fetchedExportedAmounts = response.data.exportedAmounts || 0;
  
        setVatoi(fetchedVatoi);
        setVact(fetchedVact);
        setVapa(fetchedVapa);
        setExportedAmounts(fetchedExportedAmounts);
      } catch (error) {
        console.error('Error fetching vatoi state:', error);
      }
    };
  
    fetchVatoiState();
  }, [email, bitcoinPrice]);

  // Update VAPA when cpVact changes
  useEffect(() => {
    if (vact.cpVact > 0) {
      setVapa(Math.max(vapa, vact.cpVact));
    } else {
      setVapa(bitcoinPrice); // Default to current Bitcoin price if no assets exist
    }
  }, [vact.cpVact, bitcoinPrice]);

  // Update cdVatoi when cVact or cVatoi changes
  useEffect(() => {
    const newCdVatoi = vact.cVact - vatoi.cVatoi;
    setVatoi((prev) => ({
      ...prev,
      cdVatoi: parseFloat(newCdVatoi.toFixed(2)),
    }));
  }, [vact.cVact, vatoi.cVatoi]);

  // Update cpVact based on VAPA (highest price observed)
  useEffect(() => {
    const newCpVact = Math.max(vact.cpVact, bitcoinPrice);
    if (newCpVact !== vact.cpVact) {
      const newCVact = vact.cVactTaa * newCpVact;
      setVact((prev) => ({
        ...prev,
        cpVact: newCpVact,
        cVact: parseFloat(newCVact.toFixed(2)),
      }));
    }
  }, [bitcoinPrice, vact.cVactTaa]);

  const updateAllState = async (
    newBitcoinPrice: number,
    updatedVatoi: VatoiState,
    updatedVact: VactState,
    email: string
  ) => {
    // Ensure cpVact only increases (VAPA behavior)
    const newCpVact = Math.max(updatedVact.cpVact, newBitcoinPrice);
    const newCVact = updatedVact.cVactTaa * newCpVact;
    const newVapa = Math.max(vapa, newCpVact);

    const finalVact: VactState = {
      cVact: parseFloat(newCVact.toFixed(2)),
      cpVact: newCpVact,
      cVactTaa: updatedVact.cVactTaa,
    };

    const finalVatoi: VatoiState = {
      ...updatedVatoi,
      cdVatoi: parseFloat((newCVact - updatedVatoi.cVatoi).toFixed(2)),
    };

    setVact(finalVact);
    setVatoi(finalVatoi);
    setVapa(newVapa);

    try {
      await axios.post('/api/saveVatoiState', {
        email,
        vatoi: finalVatoi,
        vact: finalVact,
        vapa: newVapa,
      });
    } catch (error) {
      console.error("Error saving vatoi state:", error);
    }
  };

  const setManualBitcoinPrice = async (
    price: number | ((currentPrice: number) => number)
  ) => {
    const newPrice = typeof price === "function" ? price(bitcoinPrice) : price;
  
    setBitcoinPrice(newPrice);
  
    // Update cpVact to be max of current cpVact and new price (VAPA behavior)
    const newCpVact = Math.max(vact.cpVact, newPrice);
    const newCVact = vact.cVactTaa * newCpVact;
  
    const updatedVact: VactState = {
      cVact: parseFloat(newCVact.toFixed(2)),
      cpVact: newCpVact,
      cVactTaa: vact.cVactTaa,
    };
  
    await updateAllState(newPrice, vatoi, updatedVact, email);
  };

  const readABTCFile = async (): Promise<number | null> => {
    try {
      if (!email) throw new Error("Email is not set in context.");
      
      const response = await axios.get('/api/readABTC', { params: { email } });
      return response.data.aBTC || 0;
    } catch (error) {
      console.error('Error reading aBTC.json:', error);
      return null;
    }
  };

  const updateABTCFile = async (amount: number): Promise<number> => {
    try {
      if (!email) throw new Error("Email is not set in context.");
      
      const response = await axios.post('/api/saveABTC', { email, amount });
  
      return response.data.aBTC;
    } catch (error) {
      console.error('Error updating aBTC.json:', error);
      throw error;
    }
  };

  let isUpdating = false;

  const handleImport = async (amount: number) => {
    if (isUpdating) {
      return;
    }
  
    isUpdating = true;
  
    try {
      const aBTC = await readABTCFile();
  
      if (aBTC === null) {
        console.error("Invalid state: aBTC is null.");
        return;
      }
  
      const currentVactTaa = vact.cVactTaa || 0;
  
      if (aBTC - currentVactTaa < 0.00001) {
        return;
      }
  
      if (aBTC > currentVactTaa) {
        const amountToImport = parseFloat((aBTC - currentVactTaa).toFixed(8));
        const importValue = amountToImport * bitcoinPrice;
  
        // Update Vatoi: accumulate the import value
        const newCVatoi = vatoi.cVatoi + importValue;
        // cpVatoi should be the price at which the first import happened, or current price if first import
        const newCpVatoi = vatoi.cpVatoi === 0 ? bitcoinPrice : vatoi.cpVatoi;
  
        // Update Vact: add tokens and recalculate value
        const newCVactTaa = vact.cVactTaa + amountToImport;
        const newCpVact = Math.max(vact.cpVact, bitcoinPrice); // VAPA behavior
        const newCVact = newCVactTaa * newCpVact;
  
        const updatedVatoi: VatoiState = {
          cVatoi: parseFloat(newCVatoi.toFixed(2)),
          cpVatoi: newCpVatoi,
          cdVatoi: 0, // Will be recalculated
        };
  
        const updatedVact: VactState = {
          cVact: parseFloat(newCVact.toFixed(2)),
          cpVact: newCpVact,
          cVactTaa: parseFloat(newCVactTaa.toFixed(8)),
        };
  
        await updateAllState(bitcoinPrice, updatedVatoi, updatedVact, email);
      }
    } catch (error) {
      console.error("Error during handleImport:", error);
    } finally {
      isUpdating = false;
    }
  };

  useEffect(() => {
    let isSyncing = false;
  
    const interval = setInterval(async () => {
      if (isSyncing) return;
  
      isSyncing = true;
  
      try {
        await readABTCFile();
        await handleImport(0); // Trigger import check
      } catch (error) {
        console.error("Error in interval execution:", error);
      } finally {
        isSyncing = false;
      }
    }, 3000);
  
    return () => clearInterval(interval);
  }, [vact.cVactTaa, email]);

  const handleImportABTC = async (amount: number) => {
    if (amount < 0.0001) {
      alert('The minimum import amount is 0.0001 BTC.');
      return;
    }
    try {
      await axios.post('/api/saveABTC', { email, amount });
    } catch (error) {
      console.error('Error saving to aBTC.json:', error);
    }
  };

  const saveVatoiState = async ({
    email,
    vatoi,
    vact,
    vapa,
    exportedAmounts,
  }: {
    email: string;
    vatoi: VatoiState;
    vact: VactState;
    vapa: number;
    exportedAmounts: number;
  }) => {
    try {
      const payload = {
        email,
        vatoi,
        vact,
        vapa,
        exportedAmounts,
      };
  
      await axios.post('/api/saveVatoiState', payload);
    } catch (error) {
      console.error('Error saving vatoi state:', error);
    }
  };

  const handleExport = async (amount: number) => {
    if (isUpdating) return;
  
    isUpdating = true;
  
    try {
      const btcAmount = parseFloat((amount / bitcoinPrice).toFixed(8));
  
      if (amount > vact.cVact) {
        alert(`Insufficient funds! You tried to export $${amount}, but only $${vact.cVact} is available.`);
        return;
      }
  
      if (btcAmount > vact.cVactTaa) {
        alert(`Insufficient tokens! You tried to export ${btcAmount} BTC, but only ${vact.cVactTaa} BTC is available.`);
        return;
      }
  
      const newABTC = await updateABTCFile(-btcAmount);
  
      // Calculate new token amount and values
      const newCVactTaa = vact.cVactTaa - btcAmount;
      const newCVact = newCVactTaa * vact.cpVact;
      
      // Update Vatoi: reduce cVatoi proportionally
      const exportRatio = btcAmount / vact.cVactTaa;
      const newCVatoi = vatoi.cVatoi * (1 - exportRatio);
  
      const updatedVact: VactState = {
        cVact: parseFloat(newCVact.toFixed(2)),
        cpVact: vact.cpVact, // Keep same price (VAPA)
        cVactTaa: parseFloat(newCVactTaa.toFixed(8)),
      };
  
      const updatedVatoi: VatoiState = {
        cVatoi: parseFloat(newCVatoi.toFixed(2)),
        cpVatoi: vatoi.cpVatoi, // Keep original import price
        cdVatoi: 0, // Will be recalculated
      };
  
      setVact(updatedVact);
      setVatoi(updatedVatoi);
      setExportedAmounts((prev) => prev + amount);
  
      await saveVatoiState({
        email,
        vatoi: updatedVatoi,
        vact: updatedVact,
        vapa,
        exportedAmounts: exportedAmounts + amount,
      });
    } catch (error) {
      console.error("Error during export operation:", error);
    } finally {
      isUpdating = false;
    }
  };

  return (
    <Vavityarchitecture.Provider
      value={{
        bitcoinPrice,
        vatoi,
        vact,
        vapa,
        importAmount,
        exportAmount,
        setImportAmount,
        setExportAmount,
        handleImport,
        handleImportABTC,
        handleExport,
        setManualBitcoinPrice,
        email,
        exportedAmounts,
        readABTCFile, 
        updateABTCFile
      }}
    >
      {children}
    </Vavityarchitecture.Provider>
  );
};

export const useVavity = () => {
  const context = useContext(Vavityarchitecture);
  if (context === undefined) {
    throw new Error('useVavity must be used within an VavityProvider');
  }
  return context;
};
