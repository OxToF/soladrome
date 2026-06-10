import { Transaction } from '../config/types';
type Props = {
    page?: number;
    pageSize?: number;
};
declare const useTransactionHistory: (props?: Props) => {
    transactions: Array<Transaction> | undefined;
    error: Array<string>;
    isFetching: boolean;
    hasMore: boolean;
};
export default useTransactionHistory;
//# sourceMappingURL=useTransactionHistory.d.ts.map