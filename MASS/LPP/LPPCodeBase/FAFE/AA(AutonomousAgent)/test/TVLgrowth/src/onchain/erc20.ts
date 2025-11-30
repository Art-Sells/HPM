import { ethers } from "ethers";

import { getBaseProvider } from "./provider";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function isUsableAddress(address?: string): address is string {
  if (!address) return false;
  const normalized = address.toLowerCase();
  if (normalized === ZERO_ADDRESS) return false;
  try {
    return ethers.isAddress(address);
  } catch {
    return false;
  }
}

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address account) view returns (uint256)",
];

const decimalsCache = new Map<string, number>();

export async function getTokenDecimals(
  tokenAddress: string
): Promise<number | null> {
  if (!isUsableAddress(tokenAddress)) {
    console.warn(`[onchain] ignoring invalid token for decimals: ${tokenAddress}`);
    return null;
  }
  const cached = decimalsCache.get(tokenAddress.toLowerCase());
  if (cached !== undefined) return cached;
  const provider = getBaseProvider();
  if (!provider) return null;
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const decimals: number = await contract.decimals();
    decimalsCache.set(tokenAddress.toLowerCase(), decimals);
    return decimals;
  } catch (err) {
    console.warn(`[onchain] failed to fetch decimals for ${tokenAddress}`, err);
    return null;
  }
}

export async function getTokenBalance(
  tokenAddress: string,
  holder: string
): Promise<bigint | null> {
  if (!isUsableAddress(tokenAddress) || !isUsableAddress(holder)) {
    console.warn(
      `[onchain] ignoring invalid token/holder for balance: ${tokenAddress} -> ${holder}`
    );
    return null;
  }
  const provider = getBaseProvider();
  if (!provider) return null;
  try {
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const balance: bigint = await contract.balanceOf(holder);
    return balance;
  } catch (err) {
    console.warn(
      `[onchain] failed to fetch balance of ${tokenAddress} for ${holder}`,
      err
    );
    return null;
  }
}

