// test/shared/expect.ts
import { expect, use } from "chai";
import { jestSnapshotPlugin } from "mocha-chai-jest-snapshot";

// @ts-expect-error — 'update' exists at runtime
use(jestSnapshotPlugin({ update: process.env.UPDATE_SNAPSHOTS === "1" }));

export { expect };