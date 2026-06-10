import { TokenId, ChainContext } from '@wormhole-foundation/sdk-definitions';
import { Network } from '@wormhole-foundation/sdk-connect';
export declare function isTokenSupported<N extends Network>(sourceToken: TokenId, fromChain: ChainContext<N>): boolean;
export declare function getContractsForNetwork(network: Network): import("@wormhole-foundation/sdk-definitions-ntt/dist/cjs").MultiTokenNtt.Contracts[];
//# sourceMappingURL=utils.d.ts.map