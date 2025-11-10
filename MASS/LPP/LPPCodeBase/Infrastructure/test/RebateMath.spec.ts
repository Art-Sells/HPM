// test/RebateMath.spec.ts
import hre from "hardhat";
const { ethers } = hre;

import { expect } from "./shared/expect.ts";
import { deployCore } from "./helpers.ts";

/** ────────────────────────────────────────────────────────────────────────────
 * Policy table (BPS) — must mirror LPPMintHook
 * ──────────────────────────────────────────────────────────────────────────── */
const POLICY = [
  { name: "T1", min:  500n, max:  999n, rebateBps: 100n, retentionBps:  50n }, // 5 – < 10
  { name: "T2", min: 1000n, max: 1999n, rebateBps: 180n, retentionBps:  90n }, // 10 – < 20
  { name: "T3", min: 2000n, max: 3499n, rebateBps: 250n, retentionBps: 125n }, // 20 – < 35
  { name: "T4", min: 5000n, max:10000n, rebateBps: 350n, retentionBps: 175n }, // ≥ 50 (cap at 100%)
] as const;

/** ────────────────────────────────────────────────────────────────────────────
 * Helpers
 * ──────────────────────────────────────────────────────────────────────────── */
const IERC20_FQN = "contracts/external/IERC20.sol:IERC20";

function localTierForShareBps(shareBps: bigint) {
  const s = shareBps > 10000n ? 10000n : shareBps;
  for (const t of POLICY) {
    if (s >= t.min && s <= t.max) return t;
  }
  return { name: "NONE", min: 0n, max: 0n, rebateBps: 0n, retentionBps: 0n } as const;
}

async function bal(token: any, who: string) {
  return BigInt((await token.balanceOf(who)).toString());
}

async function poolReserves(pool: any) {
  const rA = BigInt((await pool.reserveAsset()).toString());
  const rU = BigInt((await pool.reserveUsdc()).toString());
  return { rA, rU };
}

// Mirror the hook’s value/price math
function impliedShareBps(
  rA: bigint, rU: bigint,
  depA: bigint, depU: bigint
) {
  if (rA === 0n || rU === 0n) return 0n;
  const ONE = 10n ** 18n;
  const price1e18 = (rU * ONE) / rA; // USDC per 1 asset
  const depositValue = (depA * price1e18) / ONE + depU;
  const poolTvl     = (rA * price1e18) / ONE + rU;
  const tvlAfter    = poolTvl + depositValue;
  if (tvlAfter === 0n) return 0n;
  return (depositValue * 10000n) / tvlAfter;
}

// find a (depA, depU) equal-valued pair (in ether units) that lands inside [minBps, maxBps]
async function findDepositForTierRange(
  pool: any,
  minBps: bigint,
  maxBps: bigint,
  { start = 1n, end = 5000n }: { start?: bigint; end?: bigint } = {}
) {
  const { rA, rU } = await poolReserves(pool);

  // scan linearly in whole ether amounts; simple & deterministic for tests
  for (let x = start; x <= end; x += 1n) {
    const depA = ethers.parseEther(x.toString());
    const depU = ethers.parseEther(x.toString());
    const s = impliedShareBps(rA, rU, depA, depU);
    if (s >= minBps && s <= maxBps) {
      return { depA, depU, shareBps: s };
    }
  }
  return null;
}

async function mintPair(env: any, to: string, a: bigint, u: bigint) {
  await (await env.asset.connect(env.deployer).mint(to, a)).wait();
  await (await env.usdc.connect(env.deployer).mint(to, u)).wait();
}

async function approveBoth(tokenA: any, tokenU: any, owner: any, spender: string) {
  await (await tokenA.connect(owner).approve(spender, ethers.MaxUint256)).wait();
  await (await tokenU.connect(owner).approve(spender, ethers.MaxUint256)).wait();
}

async function getInfra(env: any) {
  const { hook, pool } = env;
  const assetAddr = await pool.asset();
  const usdcAddr  = await pool.usdc();

  const asset = await ethers.getContractAt(IERC20_FQN, assetAddr);
  const usdc  = await ethers.getContractAt(IERC20_FQN, usdcAddr);

  const treasuryAddr    = (await hook.treasury?.()) ?? env.treasury?.target ?? env.treasury?.address;
  const rebateVaultAddr = (await hook.rebateVault?.()) ?? env.rebateVault?.target ?? env.rebateVault?.address;

  const treasury = await ethers.getContractAt(
    ["function assetRetentionReceiver() view returns (address)",
     "function usdcRetentionReceiver()  view returns (address)"],
    treasuryAddr
  );
  const assetReceiver = await treasury.assetRetentionReceiver();
  const usdcReceiver  = await treasury.usdcRetentionReceiver();

  return { asset, usdc, assetReceiver, usdcReceiver, rebateVaultAddr };
}

/** ────────────────────────────────────────────────────────────────────────────
 * Specs
 * ──────────────────────────────────────────────────────────────────────────── */
describe("Rebate / Retention — tiering and token flows", () => {
  it("Tier boundaries: find valid deposits for T1/T2/T3/T4; verify flows & snapshot", async () => {
    const env = await deployCore();
    const { deployer, hook, pool } = env;
    const who = deployer;

    const { asset, usdc, assetReceiver, usdcReceiver, rebateVaultAddr } = await getInfra(env);

    // Seed pool to 100/100 so implied price = 1
    await (await hook.mintWithRebate({
      pool: await pool.getAddress(),
      to: who.address,
      amountAssetDesired: ethers.parseEther("100"),
      amountUsdcDesired:  ethers.parseEther("100"),
      data: "0x",
    })).wait();

    // For each tier, dynamically find a deposit that actually lands in its BPS window
    const tiersToTest = [
      { label: "T1", range: POLICY[0] },
      { label: "T2", range: POLICY[1] },
      { label: "T3", range: POLICY[2] },
      { label: "T4", range: POLICY[3] },
    ];

    const caseSummaries: any[] = [];

    for (const t of tiersToTest) {
      const pick = await findDepositForTierRange(pool, t.range.min, t.range.max);
      if (!pick) {
        // If we can’t find a deposit in brute-force scan, surface it clearly
        throw new Error(`Could not find deposit landing in ${t.label} range`);
      }

      const { depA, depU, shareBps } = pick;

      // pre balances
      const addrPool = await pool.getAddress();
      const a0P = await bal(asset, addrPool);
      const u0P = await bal(usdc,  addrPool);
      const a0V = await bal(asset, rebateVaultAddr);
      const u0V = await bal(usdc,  rebateVaultAddr);
      const a0T = await bal(asset, assetReceiver);
      const u0T = await bal(usdc,  usdcReceiver);
      const { rA, rU } = await poolReserves(pool);

      // fund + approve
      await mintPair(env, who.address, depA, depU);
      await approveBoth(asset, usdc, who, await hook.getAddress());

      // call hook
      const tx = await hook.mintWithRebate({
        pool: addrPool,
        to: who.address,
        amountAssetDesired: depA,
        amountUsdcDesired:  depU,
        data: "0x",
      });
      const rc = await tx.wait();

      // expected tier by the same formula
      const want = localTierForShareBps(shareBps);
      expect(want.name, `${t.label} (policy pick)`).to.equal(t.label);

      // expected splits
      const skimBps       = want.rebateBps + want.retentionBps;
      const mintAExpected = (depA * (10000n - skimBps)) / 10000n;
      const mintUExpected = (depU * (10000n - skimBps)) / 10000n;
      const rebateAExp    = (depA * want.rebateBps) / 10000n;
      const rebateUExp    = (depU * want.rebateBps) / 10000n;
      const keepAExp      = (depA * want.retentionBps) / 10000n;
      const keepUExp      = (depU * want.retentionBps) / 10000n;

      // post balances
      const a1P = await bal(asset, addrPool);
      const u1P = await bal(usdc,  addrPool);
      const a1V = await bal(asset, rebateVaultAddr);
      const u1V = await bal(usdc,  rebateVaultAddr);
      const a1T = await bal(asset, assetReceiver);
      const u1T = await bal(usdc,  usdcReceiver);

      const near = (x: bigint, y: bigint, msg: string) =>
        expect((x > y ? x - y : y - x), msg).to.be.lte(1n);

      near(a1P - a0P, mintAExpected, `${t.label} pool A mint`);
      near(u1P - u0P, mintUExpected, `${t.label} pool U mint`);
      near(a1V - a0V, rebateAExp,    `${t.label} rebateVault A`);
      near(u1V - u0V, rebateUExp,    `${t.label} rebateVault U`);
      near(a1T - a0T, keepAExp,      `${t.label} treasury(asset) retention`);
      near(u1T - u0T, keepUExp,      `${t.label} treasury(usdc) retention`);

      // events sanity
      const names = (rc!.logs || []).map((l: any) => l.fragment?.name).filter(Boolean);
      expect(names).to.include("MCVQualified");
      if (want.rebateBps > 0n) expect(names).to.include("MCVRebatePaid");

      // snapshot a concise case summary
      caseSummaries.push({
        tier: t.label,
        shareBps: shareBps.toString(),
        skimBps: skimBps.toString(),
        deposit: { asset: depA.toString(), usdc: depU.toString() },
        deltas: {
          poolAsset: (a1P - a0P).toString(),
          poolUsdc:  (u1P - u0P).toString(),
          vaultAsset:(a1V - a0V).toString(),
          vaultUsdc: (u1V - u0V).toString(),
          tresAsset: (a1T - a0T).toString(),
          tresUsdc:  (u1T - u0T).toString(),
        },
        reservesBefore: { rA: rA.toString(), rU: rU.toString() },
        events: names,
      });
    }

    expect(caseSummaries).to.matchSnapshot("rebate-retention per-tier summary");
  });

  describe("Tier math edges", () => {
    it("Equality tolerance: rejects >10 bps imbalance between A and U", async () => {
      const env = await deployCore();
      const { deployer, hook, pool } = env;
      const who = deployer;

      // Seed pool so price exists
      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: who.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      // Make USDC a bit too low (>10 bps off)
      const depA = ethers.parseEther("10");
      const depU = ethers.parseEther("9.98"); // 20 bps short
      await mintPair(env, who.address, depA, depU);
      await approveBoth(env.asset, env.usdc, who, await hook.getAddress());

      await expect(
        hook.mintWithRebate({
          pool: await pool.getAddress(),
          to: who.address,
          amountAssetDesired: depA,
          amountUsdcDesired:  depU,
          data: "0x",
        })
      ).to.be.revertedWith("unequal value");
    });

    it("Cap: S>100% behaves like T4 (skim 3.5% + 1.75%)", async () => {
      const env = await deployCore();
      const { deployer, hook, pool } = env;
      const who = deployer;
      const addrPool = await pool.getAddress();

      // Tiny seed
      await (await hook.mintWithRebate({
        pool: addrPool,
        to: who.address,
        amountAssetDesired: ethers.parseEther("1"),
        amountUsdcDesired:  ethers.parseEther("1"),
        data: "0x",
      })).wait();

      const depA = ethers.parseEther("1000");
      const depU = ethers.parseEther("1000");
      await mintPair(env, who.address, depA, depU);
      await approveBoth(env.asset, env.usdc, who, await hook.getAddress());

      const a0P = await bal(env.asset, addrPool);
      const u0P = await bal(env.usdc,  addrPool);

      const tx = await hook.mintWithRebate({
        pool: addrPool,
        to: who.address,
        amountAssetDesired: depA,
        amountUsdcDesired:  depU,
        data: "0x",
      });
      await tx.wait();

      const skimBps = 350n + 175n; // T4
      const mintAExpected = (depA * (10000n - skimBps)) / 10000n; // 94.75%
      const mintUExpected = (depU * (10000n - skimBps)) / 10000n;

      const a1P = await bal(env.asset, addrPool);
      const u1P = await bal(env.usdc,  addrPool);

      const near = (x: bigint, y: bigint) => expect((x>y?x-y:y-x)).to.be.lte(1n);
      near(a1P - a0P, mintAExpected);
      near(u1P - u0P, mintUExpected);
    });
  });

  describe("Boundary probes around 5% (T1 lower) — snapshot", () => {
    it("Just-below 5% → NONE ; just-above 5% → T1", async () => {
      const env = await deployCore();
      const { deployer, hook, pool } = env;
      const who = deployer;

      // Seed 100/100
      await (await hook.mintWithRebate({
        pool: await pool.getAddress(),
        to: who.address,
        amountAssetDesired: ethers.parseEther("100"),
        amountUsdcDesired:  ethers.parseEther("100"),
        data: "0x",
      })).wait();

      const { rA, rU } = await poolReserves(pool);

      // we brute-force a nearby integer pair for both sides of the boundary
      const below = await findDepositForTierRange(pool, 1n, 499n);      // < 5%
      const above = await findDepositForTierRange(pool, 500n, 999n);    // T1

      expect(below).to.not.equal(null);
      expect(above).to.not.equal(null);

      const snap = {
        reserves: { rA: rA.toString(), rU: rU.toString() },
        below5: {
          shareBps: below!.shareBps.toString(),
          depA: below!.depA.toString(),
          depU: below!.depU.toString(),
          tierByLocal: localTierForShareBps(below!.shareBps).name,
        },
        above5: {
          shareBps: above!.shareBps.toString(),
          depA: above!.depA.toString(),
          depU: above!.depU.toString(),
          tierByLocal: localTierForShareBps(above!.shareBps).name,
        },
      };

      expect(snap).to.matchSnapshot("5%-boundary probes");
    });
  });
});