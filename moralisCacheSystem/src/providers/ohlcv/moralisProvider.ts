import { fetchMoralisOhlcv } from '../../moralis.js';
import type { OhlcvProvider } from './types.js';

export const moralisOhlcvProvider: OhlcvProvider = {
  id: 'moralis',
  endpoint: 'getPairCandlesticks',
  fetchOhlcv: fetchMoralisOhlcv,
};
