import { TransactionLocal } from '../config/types';
export declare const getTxsFromLocalStorage: () => Array<TransactionLocal> | undefined;
export declare const addTxToLocalStorage: (data: TransactionLocal) => void;
export declare const removeTxFromLocalStorage: (txHash: string) => void;
export declare const updateTxInLocalStorage: (txHash: string, key: string, value: any) => void;
//# sourceMappingURL=inProgressTxCache.d.ts.map