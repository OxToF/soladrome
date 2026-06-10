import { ChainConfig } from '../config/types';
import { Token } from '../config/tokens';
import { WalletData } from '../store/wallet';
import { Balances } from '../utils/wallet/types';
interface UseTokenListParams {
    tokenList: Token[];
    searchQuery: string;
    selectedChainConfig: ChainConfig;
    selectedToken?: Token;
    sourceToken?: Token;
    destToken?: Token;
    wallet: WalletData;
    balances: Balances;
    isSourceList?: boolean;
}
export declare const useTokenList: ({ tokenList, searchQuery, selectedChainConfig, selectedToken, sourceToken, destToken, wallet, balances, isSourceList, }: UseTokenListParams) => Token[];
export {};
//# sourceMappingURL=useTokenList.d.ts.map