import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContractIdentity } from '../server/web3-contract.ts';

test('CEX-only projects may omit contract and network', () => {
  assert.equal(validateContractIdentity(null, null).ok, true);
  assert.equal(validateContractIdentity('', 'ethereum').ok, true);
});

test('EVM contract requires a supported network and 40 hex chars', () => {
  const address = '0x1111111111111111111111111111111111111111';
  assert.equal(validateContractIdentity(address, 'ethereum').ok, true);
  assert.equal(validateContractIdentity(address, 'bsc').ok, true);
  assert.equal(validateContractIdentity(address, null).ok, false);
  assert.equal(validateContractIdentity(address, 'unknown-chain').ok, false);
  assert.equal(validateContractIdentity('0x1234', 'ethereum').ok, false);
  assert.equal(validateContractIdentity('0x0000000000000000000000000000000000000000', 'ethereum').ok, false);
});

test('Solana contracts use base58 and reject EVM-shaped values', () => {
  assert.equal(validateContractIdentity('So11111111111111111111111111111111111111112', 'solana').ok, true);
  assert.equal(validateContractIdentity('0x1111111111111111111111111111111111111111', 'solana').ok, false);
});
