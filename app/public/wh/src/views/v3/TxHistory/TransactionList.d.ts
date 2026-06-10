import { default as React } from 'react';
import { Transaction } from '../../../config/types';
interface TransactionListProps {
    transactions: Array<Transaction> | undefined;
    hasMore: boolean;
    setPage: (page: number) => void;
}
declare const _default: React.NamedExoticComponent<TransactionListProps>;
export default _default;
//# sourceMappingURL=TransactionList.d.ts.map