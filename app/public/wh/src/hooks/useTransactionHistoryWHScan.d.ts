import { Chain, ChainId } from '@wormhole-foundation/sdk';
import { Transaction } from '../config/types';
export interface WormholeScanTransaction {
    id: string;
    content: {
        payload: {
            amount: string;
            fee?: string;
            callerAppId: string;
            fromAddress: string;
            parsedPayload: {
                feeAmount?: string;
                relayerFee?: string;
                recipientWallet: string;
                toNativeAmount: string;
            };
            toAddress: string;
            toChain: number;
            tokenAddress: string;
            tokenChain: number;
        };
        standarizedProperties: {
            appIds: Array<string>;
            fromChain: ChainId;
            fromAddress: string;
            toChain: ChainId;
            toAddress: string;
            tokenChain: ChainId;
            tokenAddress: string;
            amount: string;
            feeAddress: string;
            feeChain: number;
            fee: string;
            normalizedDecimals?: number;
        };
    };
    sourceChain: {
        chainId: number;
        timestamp: string;
        transaction: {
            txHash: string;
        };
        from: string;
        status: string;
        fee: string;
        gasTokenNotional: string;
        feeUSD: string;
    };
    targetChain?: {
        chainId: 6;
        timestamp: string;
        transaction: {
            txHash: string;
        };
        status: string;
        from: string;
        to: string;
        fee: string;
        gasTokenNotional: string;
        feeUSD: string;
    };
    data: {
        symbol: string;
        tokenAmount: string;
        usdAmount: string;
    };
}
type Props = {
    address: string;
    page?: number;
    pageSize?: number;
    chains?: Chain[];
};
declare const useTransactionHistoryWHScan: (props: Props) => {
    transactions: Array<Transaction> | undefined;
    error: string;
    isFetching: boolean;
    hasMore: boolean;
};
export default useTransactionHistoryWHScan;
//# sourceMappingURL=useTransactionHistoryWHScan.d.ts.map