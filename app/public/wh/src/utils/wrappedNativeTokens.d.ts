import { Chain, Network, TokenAddress } from '@wormhole-foundation/sdk';
export declare function getWrappedNativeToken(network: Network, chain: Chain): string | undefined;
/**
 * Determines if a token should be filtered out in same-chain swaps
 * based on native/wrapped token pair restrictions
 */
export declare function shouldFilterSameChainToken(sourceToken: {
    address: TokenAddress<Chain>;
} | null, wrappedNativeAddr: string | undefined, currentToken: {
    address: TokenAddress<Chain>;
}): boolean;
//# sourceMappingURL=wrappedNativeTokens.d.ts.map