import { Chain } from '@wormhole-foundation/sdk';
import { Transaction } from '../config/types';
type Props = {
    address: string;
    page?: number;
    pageSize?: number;
    chains?: Chain[];
};
declare const useTransactionHistoryLiFi: (props: Props) => {
    transactions: Array<Transaction> | undefined;
    error: string;
    isFetching: boolean;
    hasMore: boolean;
};
export default useTransactionHistoryLiFi;
//# sourceMappingURL=useTransactionHistoryLiFi.d.ts.map