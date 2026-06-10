import { RelayerFee } from '../store/relay';
import { Chain, AttestedTransferReceipt, RedeemedTransferReceipt, DestinationQueuedTransferReceipt, CompletedTransferReceipt, Network, routes, TokenId, amount } from '@wormhole-foundation/sdk';
import { TokenTuple, Token } from '../config/tokens';
export interface TransferInfo {
    sendTx: string;
    sender?: string;
    recipient: string;
    amount: amount.Amount;
    toChain: Chain;
    fromChain: Chain;
    tokenAddress: string;
    token: TokenTuple;
    tokenDecimals: number;
    receivedToken: TokenTuple;
    receiveAmount?: amount.Amount;
    relayerFee?: RelayerFee;
    receiveNativeAmount?: amount.Amount;
    eta?: number;
}
export type ExplorerInfo = {
    url: string;
    name: string;
};
export declare function getWormholescanExplorerInfo(txHash: string): ExplorerInfo;
export declare function getAxelarscanExplorerInfo(txHash: string): ExplorerInfo;
export declare function getExplorerInfos(route: string | routes.Route<Network>, txHash: string, fromChain: Chain, toChain: Chain): Array<ExplorerInfo>;
type ReceiptWithAttestation<AT> = AttestedTransferReceipt<AT> | RedeemedTransferReceipt<AT> | DestinationQueuedTransferReceipt<AT> | CompletedTransferReceipt<AT>;
export declare function parseReceipt(route: string, receipt: ReceiptWithAttestation<any>, getOrFetchToken: (tokenId: TokenId) => Promise<Token | undefined>): Promise<TransferInfo | null>;
export declare const isMinAmountError: (error?: Error) => error is routes.MinAmountError;
export declare function getFilteredChains(supportedChains: Array<Chain>, chainToOmit: Chain | undefined, isSource?: boolean): import('../config').ChainConfig[];
export {};
//# sourceMappingURL=sdkv2.d.ts.map