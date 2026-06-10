import { Chain } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
import { Balances } from '../utils/wallet/types';
interface UseTokenListWithSearchParams {
    baseTokenList: Token[];
    searchQuery: string;
    chain: Chain | undefined;
    isSource: boolean;
    isSameChainSwap: boolean;
    sourceToken?: Token;
    balances?: Balances;
    tokenPastingEnabled?: boolean;
}
interface UseTokenListWithSearchReturn {
    sortedTokens: Token[];
    tokenPrices: Map<string, number | undefined>;
}
/**
 * Combined hook that handles:
 * 1. Searching for tokens by address
 * 2. Merging searched tokens with base token list
 * 3. Filtering for same-chain swaps
 * 4. Fetching and managing token prices
 */
export declare const useTokenListWithSearch: ({ baseTokenList, searchQuery, chain, isSource, isSameChainSwap, sourceToken, balances, tokenPastingEnabled, }: UseTokenListWithSearchParams) => UseTokenListWithSearchReturn;
export {};
//# sourceMappingURL=useTokenListWithSearch.d.ts.map