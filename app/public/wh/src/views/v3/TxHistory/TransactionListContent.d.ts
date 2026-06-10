import { default as React } from 'react';
import { Transaction } from '../../../config/types';
import { WalletData } from '../../../store/wallet';
interface TransactionContentProps {
    transactions: Array<Transaction> | undefined;
    isFetching: boolean;
    hasMore: boolean;
    setPage: (page: number) => void;
    sendingWallet: WalletData;
}
declare const _default: React.NamedExoticComponent<TransactionContentProps>;
export default _default;
//# sourceMappingURL=TransactionListContent.d.ts.map