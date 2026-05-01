export function normalizePairAddress(chain: string, pairAddress: string) {
  return isSolanaChain(chain) ? pairAddress : pairAddress.toLowerCase();
}

export function isSolanaChain(chain: string) {
  return chain.toLowerCase() === 'solana';
}

