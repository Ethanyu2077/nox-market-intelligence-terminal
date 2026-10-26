import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeDexPaprikaNetwork, normalizeOnchainPools,resolveDexPaprikaIdentity } from '../server/dexpaprika.ts';

test('DexPaprika network aliases normalize without inventing unknown chains', () => {
  assert.equal(normalizeDexPaprikaNetwork('ETH'), 'ethereum');
  assert.equal(normalizeDexPaprikaNetwork('polygon_pos'), 'polygon');
  assert.equal(normalizeDexPaprikaNetwork('solana'), 'solana');
  assert.equal(normalizeDexPaprikaNetwork(null), null);
});

test('contract identity never falls back to an unrelated search result or case-folds non-EVM addresses',async()=>{
  const original=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({tokens:[{id:'DifferentAddress',symbol:'WRONG',chain:'solana'}]}));
  try{await assert.rejects(resolveDexPaprikaIdentity('differentaddress'),/did not resolve/);}finally{globalThis.fetch=original;}
});

test('on-chain pool normalization preserves nulls and separates liquidity from volume', () => {
  const [pool] = normalizeOnchainPools([{ id: '0xpool', dex_id: 'uniswap_v3', dex_name: 'Uniswap V3', chain: 'ethereum', liquidity_usd: '125000', volume_usd_24h: '82000', transactions_24h: 44, tokens: [{ symbol: 'NOX' }, { symbol: 'USDC' }] }]);
  assert.equal(pool.pair, 'NOX/USDC');
  assert.equal(pool.liquidityUsd, 125_000);
  assert.equal(pool.volume24hUsd, 82_000);
  assert.equal(pool.priceUsd, null);
});
