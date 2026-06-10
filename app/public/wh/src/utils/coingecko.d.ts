import { TokenId } from '@wormhole-foundation/sdk';
import { TokenMapping } from '../config/tokens';
export interface CoingeckoParams {
    abort: AbortController;
}
export declare const fetchTokenMetadata: (tokenId: TokenId, params?: CoingeckoParams) => Promise<any>;
export declare const fetchTokenPrices: (tokens: TokenId[], params?: CoingeckoParams) => Promise<TokenMapping<number>>;
//# sourceMappingURL=coingecko.d.ts.map