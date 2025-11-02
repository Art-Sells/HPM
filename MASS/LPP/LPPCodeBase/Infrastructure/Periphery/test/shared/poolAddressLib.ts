import hre from 'hardhat'
const { ethers } = hre

let helper: any;
async function getHelper() {
  if (!helper) {
    const Fac = await ethers.getContractFactory('PoolAddressTest')
    helper = await Fac.deploy()
    await helper.waitForDeployment()
  }
  return helper
}

export async function getInitHash(): Promise<string> {
  const h = await getHelper()
  // works whether you expose a constant or a function
  if (h.POOL_INIT_CODE_HASH) return h.POOL_INIT_CODE_HASH()
  if (h.getInitHash) return h.getInitHash()
  throw new Error('PoolAddressTest: no init hash accessor')
}

export async function computeExpectedPool(
  factory: string,
  token0: string,
  token1: string,
  // keep optional fee param so call sites don’t break
  _fee?: number
): Promise<string> {
  const h: any = await getHelper()
  // Prefer new 3-arg signature; fallback to 4-arg (passing 0) if you still have an old helper around
  try {
    return await h['computeAddress(address,address,address)'](factory, token0, token1)
  } catch {
    return await h['computeAddress(address,address,address,uint24)'](factory, token0, token1, 0)
  }
}