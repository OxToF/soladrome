import { ChainName as MayanChainName } from '@mayanfinance/swap-sdk';
import { ChainName as MayanTestnetChainName } from '@testnet-mayan/swap-sdk';
import { Chain, TransactionId, routes, Network } from '@wormhole-foundation/sdk-connect';
import { TransactionStatus } from './types';
export declare function getNativeContractAddress(chain: Chain): string;
export declare function getDefaultDeadline(chain: Chain): number;
export declare function toMayanChainName(network: Network, chain: Chain): MayanChainName | MayanTestnetChainName;
export declare function isTestnetSupportedChain(chain: Chain): boolean;
export declare function fromMayanChainName(mayanChain: MayanChainName): Chain;
export declare function toWormholeChainName(chainIdStr: string): Chain;
export declare function supportedChains(network?: Network): Chain[];
export declare function txStatusToReceipt(txStatus: TransactionStatus): routes.Receipt;
export declare function getTransactionStatus(network: Network, tx: TransactionId): Promise<TransactionStatus | null>;
//# sourceMappingURL=utils.d.ts.map