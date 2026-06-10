import { Wormhole, TokenId, Network, Chain } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
interface TokenMetadataFromRpc {
    symbol: string;
    name: string;
    icon?: string;
}
export declare function getTokenMetadataFromRpc(tokenId: TokenId): Promise<TokenMetadataFromRpc | undefined>;
export declare function getTokenMetadataSolana(wh: Wormhole<Network>, tokenId: TokenId): Promise<TokenMetadataFromRpc | undefined>;
export declare function getTokenMetadataEvm(wh: Wormhole<Network>, tokenId: TokenId): Promise<TokenMetadataFromRpc | undefined>;
export declare function getTokenMetadataSui(wh: Wormhole<Network>, tokenId: TokenId): Promise<TokenMetadataFromRpc | undefined>;
/**
 * Find a token by address or symbol.
 * First tries to find by address, then falls back to symbol if not found.
 * @param chain - The chain to search on
 * @param address - The token address (optional)
 * @param symbol - The token symbol (optional)
 * @returns The found token or undefined
 */
export declare function findToken(chain: Chain | undefined, address?: string, symbol?: string): Token | undefined;
export {};
//# sourceMappingURL=tokens.d.ts.map