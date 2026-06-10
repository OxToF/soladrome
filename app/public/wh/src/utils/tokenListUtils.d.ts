import { ChainConfig } from '../config/types';
import { Token } from '../config/tokens';
import { Balances } from './wallet/types';
export declare const getTokenPreferenceScore: (token: Token, selectedToken?: Token, oppositeToken?: Token) => number;
export declare const calculateTokenUSDBalance: (token: Token, balances: Balances, getTokenPrice: (token: Token) => number | undefined) => number;
export declare const applyTokenSearch: (tokenList: Token[], searchQuery: string, selectedChainConfig: ChainConfig) => Token[];
export declare const sortTokensByPreference: (tokens: Token[], selectedToken: Token | undefined, balances: Balances, getTokenPrice: (token: Token) => number | undefined, oppositeToken?: Token) => Token[];
export declare const applyTokenWhitelist: (tokens: Token[], selectedChainConfig: ChainConfig) => Token[];
export declare const applyCustomTokenSupport: (tokens: Token[], sourceToken?: Token, isSourceList?: boolean) => Token[];
export declare const applyShittokenFilter: (tokens: Token[]) => Token[];
export declare const filterTokensByBalance: (tokens: Token[], balances: Record<string, {
    balance: any;
}>, walletAddress?: string) => Token[];
//# sourceMappingURL=tokenListUtils.d.ts.map