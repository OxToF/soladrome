import { PayloadAction } from '@reduxjs/toolkit';
import { TransferInfo } from '../utils/sdkv2';
export interface RedeemState {
    txData?: TransferInfo;
    sendTx: string;
    redeemTx: string;
    transferComplete: boolean;
    route?: string;
    isResumeTx: boolean;
    timestamp: number;
}
export declare const redeemSlice: import('@reduxjs/toolkit').Slice<RedeemState, {
    setTxDetails: (state: RedeemState, { payload }: PayloadAction<TransferInfo>) => void;
    setSendTx: (state: RedeemState, { payload }: PayloadAction<string>) => void;
    setRoute: (state: RedeemState, { payload }: {
        payload: any;
        type: string;
    }) => void;
    clearRedeem: (state: RedeemState) => void;
    setIsResumeTx: (state: RedeemState, { payload }: PayloadAction<boolean>) => void;
    setTimestamp: (state: RedeemState, { payload }: PayloadAction<number>) => void;
}, "redeem", "redeem", import('@reduxjs/toolkit').SliceSelectors<RedeemState>>;
export declare const setTxDetails: import('@reduxjs/toolkit').ActionCreatorWithPayload<TransferInfo, "redeem/setTxDetails">, setSendTx: import('@reduxjs/toolkit').ActionCreatorWithPayload<string, "redeem/setSendTx">, clearRedeem: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"redeem/clearRedeem">, setRoute: import('@reduxjs/toolkit').ActionCreatorWithPayload<any, "redeem/setRoute">, setIsResumeTx: import('@reduxjs/toolkit').ActionCreatorWithPayload<boolean, "redeem/setIsResumeTx">, setTimestamp: import('@reduxjs/toolkit').ActionCreatorWithPayload<number, "redeem/setTimestamp">;
declare const _default: import('@reduxjs/toolkit').Reducer<RedeemState>;
export default _default;
//# sourceMappingURL=redeem.d.ts.map