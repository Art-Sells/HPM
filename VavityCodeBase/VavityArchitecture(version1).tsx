'use client';

import { useUser } from './UserContext';
import axios from 'axios';
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { fetchBitcoinPrice, setManualBitcoinPrice as setManualBitcoinPriceApi } from '../lib/coingecko-api';
import { fetchUserAttributes } from 'aws-amplify/auth';

interface VatoiState {
  cVatoi: number; // Value of the asset investment at the time of import
  cpVatoi: number; // Asset price at the time of import
  cdVatoi: number; // Difference between cVact and cVatoi: cdVatoi = cVact - cVatoi
  cVact: number; // Current value of the asset investment
  cpVact: number; // Current price of the asset
  cVactTaa: number; // Token amount of the asset available
}

interface VavityarchitectureType {
  bitcoinPrice: number;
  vatoiState: VatoiState | null;
  vataai: number; // Valued Asset Price Anchored At Import (replaces HPAP)
  vapa: number; // Valued Asset Price Anchored (replaces HAP)
  importAmount: number;
  sellAmount: number;
  setImportAmount: (amount: number) => void;
  setSellAmount: (amount: number) => void;
  handleImport: (amount: number) => void;
  handleImportABTC: (amount: number) => void;
  handleSell: (amount: number) => void;
  setManualBitcoinPrice: (price: number | ((currentPrice: number) => number)) => void;
  soldAmounts: number;
  email: string;
  readABTCFile: () => Promise<number | null>;
  updateABTCFile: (amount: number) => Promise<number>;
}

const Vavityarchitecture = createContext<VavityarchitectureType | undefined>(undefined);

export const VavityProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [email, setEmail] = useState<string>('');
  const [bitcoinPrice, setBitcoinPrice] = useState<number>(60000);
  const [importAmount, setImportAmount] = useState<number>(0);
  const [sellAmount, setSellAmount] = useState<number>(0);
  const [vatoiState, setVatoiState] = useState<VatoiState | null>(null);
  const [vataai, setVataai] = useState<number>(60000); // Valued Asset Price Anchored At Import
  const [vapa, setVapa] = useState<number>(60000); // Valued Asset Price Anchored
  const [soldAmounts, setSoldAmounts] = useState<number>(0);

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
        const fetchedState = response.data.vatoiState || null;
        const fetchedSoldAmounts = response.data.soldAmounts || 0;
        const fetchedVataai = response.data.vataai || bitcoinPrice;
        const fetchedVapa = response.data.vapa || bitcoinPrice;
  
        if (fetchedState) {
          setVatoiState(fetchedState);
          // Recalculate cdVatoi
          const updatedState = {
            ...fetchedState,
            cdVatoi: parseFloat((fetchedState.cVact - fetchedState.cVatoi).toFixed(2)),
          };
          setVatoiState(updatedState);
        }
        
        setSoldAmounts(fetchedSoldAmounts);
        setVataai(fetchedVataai);
        setVapa(fetchedVapa);
      } catch (error) {
        console.error('Error fetching vatoi state:', error);
      }
    };
  
    fetchVatoiState();
  }, [email, bitcoinPrice]);

  useEffect(() => {
    if (!vatoiState) {
      setVataai(bitcoinPrice); // Default VATAAI to current Bitcoin price if no state exists
      setVapa(bitcoinPrice);
      return;
    }
  
    // VATAAI is the highest cpVact (which is the same as cpVatoi initially, then increases)
    setVataai(Math.max(vatoiState.cpVact, vataai));
    // VAPA is the highest valued asset price anchored
    setVapa(Math.max(vatoiState.cpVact, vapa));
  }, [vatoiState, bitcoinPrice]);

  const updateAllState = async (
    newBitcoinPrice: number,
    updatedState: VatoiState | null,
    email: string
  ) => {
    if (!updatedState) {
      setVatoiState(null);
      setVataai(newBitcoinPrice);
      setVapa(newBitcoinPrice);
      
      try {
        await axios.post('/api/saveVatoiState', {
          email,
          vatoiState: null,
          vataai: newBitcoinPrice,
          vapa: newBitcoinPrice,
        });
      } catch (error) {
        console.error("Error saving vatoi state:", error);
      }
      return;
    }

    // Update cpVact based on VAPA (highest price observed)
    const newCpVact = Math.max(updatedState.cpVact, newBitcoinPrice);
    // Recalculate cVact based on cVactTaa and new cpVact
    const newCVact = parseFloat((updatedState.cVactTaa * newCpVact).toFixed(2));
    // Recalculate cdVatoi
    const newCdVatoi = parseFloat((newCVact - updatedState.cVatoi).toFixed(2));

    const processedState: VatoiState = {
      ...updatedState,
      cpVact: newCpVact,
      cVact: newCVact,
      cdVatoi: newCdVatoi,
    };

    // Update VATAAI and VAPA
    const newVataai = Math.max(newCpVact, vataai);
    const newVapa = Math.max(newCpVact, vapa);

    setVatoiState(processedState);
    setVataai(newVataai);
    setVapa(newVapa);

    try {
      await axios.post('/api/saveVatoiState', {
        email,
        vatoiState: processedState,
        vataai: newVataai,
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
  
    setBitcoinPrice(newPrice); // Update the state immediately
  
    if (!vatoiState) {
      await updateAllState(newPrice, null, email);
      return;
    }

    // Update cpVact based on VAPA (highest price observed)
    const newCpVact = Math.max(vatoiState.cpVact, newPrice);
    // Recalculate cVact
    const newCVact = parseFloat((vatoiState.cVactTaa * newCpVact).toFixed(2));
    // Recalculate cdVatoi
    const newCdVatoi = parseFloat((newCVact - vatoiState.cVatoi).toFixed(2));

    const updatedState: VatoiState = {
      ...vatoiState,
      cpVact: newCpVact,
      cVact: newCVact,
      cdVatoi: newCdVatoi,
    };
  
    await updateAllState(newPrice, updatedState, email);
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
  
      // Return the updated aBTC value from the server response
      return response.data.aBTC;
    } catch (error) {
      console.error('Error updating aBTC.json:', error);
      throw error;
    }
  };

  let isUpdating = false; // Shared lock variable
  
  const handleImport = async (amount: number) => {
    if (isUpdating) {
      return;
    }
  
    isUpdating = true;
  
    try {
      const aBTC = await readABTCFile(); // Fetch the current aBTC value
  
      if (aBTC === null) {
        console.error("Invalid state: aBTC is null.");
        return;
      }
  
      const currentCVactTaa = vatoiState?.cVactTaa || 0;
  
      if (aBTC - currentCVactTaa < 0.00001) {
        return;
      }
  
      if (aBTC > currentCVactTaa) {
        const amountToImport = parseFloat((aBTC - currentCVactTaa).toFixed(8));
        const currentPrice = bitcoinPrice;

        if (!vatoiState) {
          // First import - create new state
          const newState: VatoiState = {
            cVatoi: amountToImport * currentPrice,
            cpVatoi: currentPrice,
            cdVatoi: 0,
            cVact: amountToImport * currentPrice,
            cpVact: currentPrice,
            cVactTaa: amountToImport,
          };
          await updateAllState(currentPrice, newState, email);
        } else {
          // Additional import - accumulate values
          const newCVactTaa = vatoiState.cVactTaa + amountToImport;
          const newCVatoi = vatoiState.cVatoi + (amountToImport * currentPrice);
          // cpVatoi should be the weighted average or the initial import price
          // For simplicity, keeping the original cpVatoi
          const newCVact = parseFloat((newCVactTaa * Math.max(vatoiState.cpVact, currentPrice)).toFixed(2));
          const newCpVact = Math.max(vatoiState.cpVact, currentPrice);
          const newCdVatoi = parseFloat((newCVact - newCVatoi).toFixed(2));

          const updatedState: VatoiState = {
            cVatoi: newCVatoi,
            cpVatoi: vatoiState.cpVatoi, // Keep original import price
            cdVatoi: newCdVatoi,
            cVact: newCVact,
            cpVact: newCpVact,
            cVactTaa: newCVactTaa,
          };
          await updateAllState(currentPrice, updatedState, email);
        }
      }
    } catch (error) {
      console.error("Error during handleImport:", error);
    } finally {
      isUpdating = false;
    }
  };

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
    vatoiState,
    vataai,
    vapa,
    soldAmounts,
  }: {
    email: string;
    vatoiState: VatoiState | null;
    vataai: number;
    vapa: number;
    soldAmounts: number;
  }) => {
    try {
      const payload = {
        email,
        vatoiState,
        vataai,
        vapa,
        soldAmounts,
      };
  
      const response = await axios.post('/api/saveVatoiState', payload);
    } catch (error) {
      console.error('Error saving vatoi state:', error);
    }
  };

  const handleSell = async (amount: number) => {
    if (isUpdating) return;
  
    isUpdating = true;
  
    try {
      if (!vatoiState || vatoiState.cVact <= 0) {
        alert(`Insufficient assets! You tried to sell $${amount}, but no assets are available.`);
        return;
      }

      const btcAmount = parseFloat((amount / bitcoinPrice).toFixed(8));
  
      if (amount > vatoiState.cVact) {
        alert(`Insufficient assets! You tried to sell $${amount}, but only $${vatoiState.cVact} is available.`);
        return;
      }
  
      const newABTC = await updateABTCFile(-btcAmount);
  
      // Calculate new values after sell
      const sellRatio = amount / vatoiState.cVact;
      const newCVactTaa = parseFloat((vatoiState.cVactTaa * (1 - sellRatio)).toFixed(8));
      const newCVatoi = parseFloat((vatoiState.cVatoi * (1 - sellRatio)).toFixed(2));
      const newCVact = parseFloat((newCVactTaa * vatoiState.cpVact).toFixed(2));
      const newCdVatoi = parseFloat((newCVact - newCVatoi).toFixed(2));

      if (newCVactTaa <= 0.00001) {
        // All assets sold, reset state
        setVatoiState(null);
        setSoldAmounts((prev) => prev + amount);
        await saveVatoiState({
          email,
          vatoiState: null,
          vataai,
          vapa,
          soldAmounts: soldAmounts + amount,
        });
      } else {
        const updatedState: VatoiState = {
          cVatoi: newCVatoi,
          cpVatoi: vatoiState.cpVatoi,
          cdVatoi: newCdVatoi,
          cVact: newCVact,
          cpVact: vatoiState.cpVact,
          cVactTaa: newCVactTaa,
        };
  
        setVatoiState(updatedState);
        setSoldAmounts((prev) => prev + amount);
  
        await saveVatoiState({
          email,
          vatoiState: updatedState,
          vataai,
          vapa,
          soldAmounts: soldAmounts + amount,
        });
      }
    } catch (error) {
      console.error("Error during sell operation:", error);
    } finally {
      isUpdating = false;
    }
  };

  return (
    <Vavityarchitecture.Provider
      value={{
        bitcoinPrice,
        vatoiState,
        vataai,
        vapa,
        importAmount,
        sellAmount,
        setImportAmount,
        setSellAmount,
        handleImport,
        handleImportABTC,
        handleSell,
        setManualBitcoinPrice,
        email,
        soldAmounts,
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
