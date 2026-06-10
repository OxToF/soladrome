import { Token } from '../config/tokens';
import { Balances } from '../utils/wallet';
export declare function useTokenListGrouping({ sortedTokens, isGroupingEnabled, isWalletConnected, balances, }: {
    sortedTokens: Token[];
    isWalletConnected: boolean;
    isGroupingEnabled: boolean;
    balances: Balances;
}): {
    listItems: Token[];
    ownedCount: number;
};
//# sourceMappingURL=useTokenListGrouping.d.ts.map