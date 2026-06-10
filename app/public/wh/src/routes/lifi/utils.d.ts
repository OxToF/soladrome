import { ChainId, TimingStrategy, TimingStrategyString, StatusResponse } from '@lifi/sdk';
import { Chain, ChainContext, TokenId, TransactionId, Network } from '@wormhole-foundation/sdk-connect';
export declare function getNativeContractAddress(chain: Chain): string;
export declare function toLifiTokenAddress(tokenId: TokenId): string;
export declare function generateThrowawayAddress(chain: Chain): string;
export declare function getNativeChainId<N extends Network>(chainContext: ChainContext<N>): Promise<bigint>;
export declare function toLifiChainId(chain: Chain): ChainId;
export declare function lifiChainIdToChain(chainId: ChainId): Chain;
export declare function supportedChains(network?: Network): Chain[];
export declare function mapTokenIdToLifiToken(tokenId: TokenId): string;
export declare function mapLifiTokenToTokenId(tokenAddress: string, chain: Chain): TokenId;
export declare function getTransactionStatus(_network: Network, tx: TransactionId, fromChain: string, toChain: string, bridge?: string): Promise<StatusResponse | null>;
export declare function parseTimingStrategy(strategy: TimingStrategyString): TimingStrategy;
//# sourceMappingURL=utils.d.ts.map