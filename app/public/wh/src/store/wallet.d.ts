import { PayloadAction } from '@reduxjs/toolkit';
import { Platform } from '@wormhole-foundation/sdk';
import { TransferWallet } from '../utils/wallet';
export type WalletData = {
    type: Platform | undefined;
    address: string;
    currentAddress: string;
    error: string;
    icon?: string;
    name: string;
};
export interface WalletState {
    sending: WalletData;
    receiving: WalletData;
}
export type ConnectPayload = {
    address: string;
    type: Platform;
    icon?: string;
    name: string;
};
export declare const walletSlice: import('@reduxjs/toolkit').Slice<WalletState, {
    connectWallet: (state: WalletState, { payload }: PayloadAction<ConnectPayload>) => void;
    connectReceivingWallet: (state: WalletState, { payload }: PayloadAction<ConnectPayload>) => void;
    clearWallet: (state: WalletState, { payload }: PayloadAction<TransferWallet>) => void;
    setWalletError: (state: WalletState, { payload }: PayloadAction<{
        type: TransferWallet;
        error: string;
    }>) => void;
    clearWallets: (state: WalletState) => void;
    swapWallets: (state: WalletState) => void;
}, "wallet", "wallet", import('@reduxjs/toolkit').SliceSelectors<WalletState>>;
export declare const connectWallet: import('@reduxjs/toolkit').ActionCreatorWithPayload<ConnectPayload, "wallet/connectWallet">, connectReceivingWallet: import('@reduxjs/toolkit').ActionCreatorWithPayload<ConnectPayload, "wallet/connectReceivingWallet">, clearWallet: import('@reduxjs/toolkit').ActionCreatorWithPayload<TransferWallet, "wallet/clearWallet">, setWalletError: import('@reduxjs/toolkit').ActionCreatorWithPayload<{
    type: TransferWallet;
    error: string;
}, "wallet/setWalletError">, clearWallets: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"wallet/clearWallets">, swapWallets: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"wallet/swapWallets">;
declare const _default: import('@reduxjs/toolkit').Reducer<WalletState>;
export default _default;
//# sourceMappingURL=wallet.d.ts.map