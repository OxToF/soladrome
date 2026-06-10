import { Route } from '@lifi/sdk';
import { TokenId, Network } from '@wormhole-foundation/sdk-connect';
import { PlatformContext } from '../types';
export declare function generateThrowawayAddress(): string;
export declare function executeEvmSteps<N extends Network>(route: Route, context: PlatformContext<N>, quote: any, nativeChainId: bigint, toLifiTokenAddress: (tokenId: TokenId) => string): Promise<void>;
//# sourceMappingURL=evm.d.ts.map