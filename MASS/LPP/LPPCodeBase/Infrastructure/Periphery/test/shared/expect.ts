// test/shared/expect.ts
import { expect, use } from "chai";
import { solidity } from "ethereum-waffle";
import { jestSnapshotPlugin } from "mocha-chai-jest-snapshot";

use(solidity);

// @ts-expect-error — 'update' is supported at runtime but not in types
use(jestSnapshotPlugin({ update: process.env.UPDATE_SNAPSHOTS === "1" }));

export { expect };