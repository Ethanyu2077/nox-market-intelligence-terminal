import { web3ChainId } from './binance-web3.ts';

const EVM_CHAINS = new Set(['1', '56', '8453', '42161', '137', '10', '43114', '324', '59144', '5000', '81457', '169', '1284', '100']);

/** Validates a project's optional Web3 identity. A CEX-only project (no contract) is valid. */
export function validateContractIdentity(contract: string | null | undefined, network: string | null | undefined): { ok: true } | { ok: false; message: string } {
  const address = contract?.trim() ?? '';
  if (!address) return { ok: true };
  const chainId = web3ChainId(network ?? null);
  if (!network || !chainId) return { ok: false, message: `Web3 contract requires a supported network (got ${network ?? 'none'})` };
  if (EVM_CHAINS.has(chainId)) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/i.test(address)) return { ok: false, message: 'Invalid EVM contract address (expected 0x + 40 hex)' };
  } else if (chainId === 'solana' || chainId === 'CT_501') {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return { ok: false, message: 'Invalid Solana contract address' };
  } else if (address.length < 8 || address.length > 100 || /\s/.test(address)) {
    return { ok: false, message: 'Invalid contract address for this chain' };
  }
  return { ok: true };
}
