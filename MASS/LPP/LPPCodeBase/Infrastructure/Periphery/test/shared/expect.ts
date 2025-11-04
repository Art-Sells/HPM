// test/shared/expect.ts
import { createRequire } from 'module';
const require = createRequire(import.meta.url);

// Load CJS modules via require to avoid ESM resolution quirks
// eslint-disable-next-line @typescript-eslint/no-var-requires
const chai = require('chai');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const snapshot = require('mocha-chai-jest-snapshot');

// Support both named and default export shapes
const jestSnapshotPlugin =
  (snapshot && snapshot.jestSnapshotPlugin) || snapshot.default || snapshot;

chai.use(
  jestSnapshotPlugin({
    update: process.env.UPDATE_SNAPSHOTS === '1',
  })
);

// Export expect like before
export const { expect } = chai as typeof import('chai');