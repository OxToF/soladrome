import { Chain, Network } from '@wormhole-foundation/sdk-base';
import { routes } from '@wormhole-foundation/sdk-connect';
import { Quote as MayanQuote } from '@mayanfinance/swap-sdk';
export declare enum MayanProtocol {
    WH = "WH",
    MCTP = "MCTP",
    SWIFT = "SWIFT",
    FAST_MCTP = "FAST_MCTP",
    SHUTTLE = "SHUTTLE",
    MONO_CHAIN = "MONO_CHAIN"
}
export type ReferrerParams<N extends Network> = {
    getReferrerBps?: (request: routes.RouteTransferRequest<N>) => number;
    referrers?: Partial<Record<Chain, string>>;
};
export type Options = {
    gasDrop: number;
    slippageBps: number | 'auto';
    optimizeFor: 'cost' | 'speed';
};
export type NormalizedParams = {
    slippageBps: number | 'auto';
};
export interface ValidatedParams extends routes.ValidatedTransferParams<Options> {
    normalizedParams: NormalizedParams;
}
export type Quote = routes.Quote<Options, ValidatedParams, MayanQuote>;
export type QuoteResult = routes.QuoteResult<Options, ValidatedParams, MayanQuote>;
export type Receipt = routes.Receipt;
export type TransferParams = routes.TransferParams<Options>;
export type ValidationResult = routes.ValidationResult<Options>;
interface MayanTx {
    txHash: string;
    goals: MayanTransactionGoal[];
    scannerUrl: string;
}
export interface TransactionStatus {
    id: string;
    trader: string;
    sourceChain: string;
    sourceTxHash: string;
    sourceTxBlockNo: number;
    transferSequence: string;
    swapSequence: string;
    redeemSequence: string;
    refundSequence: string;
    fulfillSequence: string;
    deadline: string;
    swapChain: string;
    refundChain: string;
    destChain: string;
    destAddress: string;
    fromTokenAddress: string;
    fromTokenChain: string;
    fromTokenSymbol: string;
    fromAmount: string;
    fromAmount64: any;
    toTokenAddress: string;
    toTokenChain: string;
    toTokenSymbol: string;
    stateAddr: string;
    stateNonce: string;
    toAmount: any;
    transferSignedVaa: string;
    swapSignedVaa: string;
    redeemSignedVaa: string;
    refundSignedVaa: string;
    fulfillSignedVaa: string;
    savedAt: string;
    initiatedAt: string;
    completedAt: string;
    insufficientFees: boolean;
    retries: number;
    swapRelayerFee: string;
    redeemRelayerFee: string;
    refundRelayerFee: string;
    bridgeFee: string;
    statusUpdatedAt: string;
    redeemTxHash: string;
    refundTxHash: string;
    fulfillTxHash: string;
    unwrapRedeem: boolean;
    unwrapRefund: boolean;
    auctionAddress: string;
    driverAddress: string;
    mayanAddress: string;
    referrerAddress: string;
    auctionStateAddr: any;
    auctionStateNonce: any;
    gasDrop: string;
    gasDrop64: any;
    payloadId: number;
    orderHash: string;
    minAmountOut: any;
    minAmountOut64: any;
    service: string;
    refundAmount: string;
    posAddress: string;
    unlockRecipient: any;
    fromTokenLogoUri: string;
    toTokenLogoUri: string;
    fromTokenScannerUrl: string;
    toTokenScannerUrl: string;
    txs: MayanTx[];
    clientStatus: MayanClientStatus;
}
export declare enum MayanClientStatus {
    INPROGRESS = "INPROGRESS",
    COMPLETED = "COMPLETED",
    REFUNDED = "REFUNDED",
    CANCELED = "CANCELED"
}
export declare enum MayanTransactionGoal {
    Send = "SEND",
    Bridge = "BRIDGE",
    Swap = "SWAP",
    Register = "REGISTER",
    Settle = "SETTLE"
}
export {};
//# sourceMappingURL=types.d.ts.map