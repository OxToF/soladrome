import { amount, Chain } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
import { WalletData } from '../store/wallet';
interface BalanceCache {
    balance: amount.Amount;
    lastUpdated: number;
}
declare const getCached: (wallet: WalletData, token: Token) => BalanceCache | null;
declare const setCached: (wallet: WalletData, token: Token, balance: amount.Amount) => void;
declare const markFailed: (chain: Chain, tokenAddr: string) => void;
declare const isFailed: (chain: Chain, tokenAddr: string) => boolean;
declare const clearCache: (wallet: WalletData, chain: Chain) => void;
export { getCached, setCached, clearCache, markFailed, isFailed };
//# sourceMappingURL=balanceCache.d.ts.map