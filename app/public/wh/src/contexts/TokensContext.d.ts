import { TokenId } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
import { ReactNode, default as React } from 'react';
interface TokensContextType {
    getOrFetchToken: (tokenId: TokenId) => Promise<Token | undefined>;
    isFetchingToken: boolean;
    lastTokenCacheUpdate: Date;
    getTokenPrice: (token: Token) => number | undefined;
    getTokenPrices: (tokens: Token[]) => Map<string, number | undefined>;
    isFetchingTokenPrices: boolean;
    lastTokenPriceUpdate: Date;
}
export declare const TokensContext: React.Context<TokensContextType | undefined>;
interface TokensProviderProps {
    children: ReactNode;
}
export interface TokenPrice {
    price: number | undefined;
    timestamp: Date;
    isFetching?: boolean;
}
export declare const TokensProvider: React.FC<TokensProviderProps>;
export declare const useTokens: () => TokensContextType;
export {};
//# sourceMappingURL=TokensContext.d.ts.map