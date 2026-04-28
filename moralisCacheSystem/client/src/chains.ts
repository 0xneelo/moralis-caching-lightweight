export type ChainOption = {
  value: string;
  label: string;
  family: 'EVM' | 'Solana' | 'Other';
};

export const chainOptions: ChainOption[] = [
  { value: 'eth', label: 'Ethereum', family: 'EVM' },
  { value: 'base', label: 'Base', family: 'EVM' },
  { value: 'solana', label: 'Solana', family: 'Solana' },
  { value: 'bsc', label: 'BNB Smart Chain', family: 'EVM' },
  { value: 'polygon', label: 'Polygon', family: 'EVM' },
  { value: 'arbitrum', label: 'Arbitrum', family: 'EVM' },
  { value: 'optimism', label: 'Optimism', family: 'EVM' },
  { value: 'avalanche', label: 'Avalanche', family: 'EVM' },
  { value: 'fantom', label: 'Fantom', family: 'EVM' },
  { value: 'cronos', label: 'Cronos', family: 'EVM' },
  { value: 'gnosis', label: 'Gnosis', family: 'EVM' },
  { value: 'linea', label: 'Linea', family: 'EVM' },
  { value: 'moonbeam', label: 'Moonbeam', family: 'EVM' },
  { value: 'flow', label: 'Flow', family: 'EVM' },
  { value: 'lisk', label: 'Lisk', family: 'EVM' },
  { value: 'ronin', label: 'Ronin', family: 'EVM' },
  { value: 'pulse', label: 'PulseChain', family: 'EVM' },
  { value: 'sei', label: 'Sei', family: 'EVM' },
  { value: 'opbnb', label: 'opBNB', family: 'EVM' },
  { value: 'zksync', label: 'zkSync Era', family: 'EVM' },
  { value: 'polygon-zkevm', label: 'Polygon zkEVM', family: 'EVM' },
  { value: 'zetachain', label: 'ZetaChain', family: 'EVM' },
  { value: 'blast', label: 'Blast', family: 'EVM' },
  { value: 'mantle', label: 'Mantle', family: 'EVM' },
  { value: 'chiliz', label: 'Chiliz', family: 'EVM' },
  { value: 'hyperevm', label: 'HyperEVM', family: 'EVM' },
  { value: 'monad', label: 'Monad', family: 'EVM' },
  { value: 'bitcoin', label: 'Bitcoin', family: 'Other' },
  { value: 'stellar', label: 'Stellar', family: 'Other' },
];

export function getChainLabel(value: string) {
  return chainOptions.find((chain) => chain.value === value)?.label ?? value;
}

export function getDexscreenerChainSlug(value: string) {
  const overrides: Record<string, string> = {
    eth: 'ethereum',
    bsc: 'bsc',
    polygon: 'polygon',
    'polygon-zkevm': 'polygonzkevm',
    avalanche: 'avalanche',
    arbitrum: 'arbitrum',
    optimism: 'optimism',
    zksync: 'zksync',
    opbnb: 'opbnb',
    pulse: 'pulsechain',
  };

  return overrides[value] ?? value;
}
