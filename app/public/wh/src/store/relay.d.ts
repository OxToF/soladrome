import { PayloadAction } from '@reduxjs/toolkit';
import { TokenTuple } from '../config/tokens';
export interface RelayerFee {
    fee: number;
    token?: TokenTuple;
}
export interface RelayState {
    maxSwapAmt: number | undefined;
    toNativeToken: number;
    receiveNativeAmt: number | undefined;
    relayerFee: RelayerFee | undefined;
    receiverNativeBalance: string | undefined;
}
export declare const relaySlice: import('@reduxjs/toolkit').Slice<RelayState, {
    setToNativeToken: (state: RelayState, { payload }: PayloadAction<number>) => void;
    clearRelay: (state: RelayState) => void;
}, "transfer", "transfer", import('@reduxjs/toolkit').SliceSelectors<RelayState>>;
export declare const setToNativeToken: import('@reduxjs/toolkit').ActionCreatorWithPayload<number, "transfer/setToNativeToken">;
declare const _default: import('@reduxjs/toolkit').Reducer<RelayState>;
export default _default;
//# sourceMappingURL=relay.d.ts.map