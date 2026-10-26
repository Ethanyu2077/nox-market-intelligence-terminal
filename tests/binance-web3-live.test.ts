import test from 'node:test';
import assert from 'node:assert/strict';
import {BinanceWeb3Client} from '../server/binance-web3-client.ts';

test('real Binance Web3 signed capability request (explicit opt-in, no wallet data)',{skip:process.env.NOX_TEST_BINANCE_WEB3_LIVE!=='true'},async()=>{
  const client=new BinanceWeb3Client();assert.ok(client.configured,'Configure server-side Web3 developer credentials');
  const response=await client.request('/api/v1/dex/market/supported/chain',{});
  assert.ok(Array.isArray(response.data));assert.ok(response.data.length>0);
});
