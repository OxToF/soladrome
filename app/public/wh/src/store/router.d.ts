import { PayloadAction } from '@reduxjs/toolkit';
import { TransferWallet } from '../utils/wallet';
export type Route = 'bridge' | 'redeem' | 'history' | 'search' | 'terms';
export interface RouterState {
    route: Route;
    showFromChainsModal: boolean;
    showToChainsModal: boolean;
    showTokensModal: boolean;
    showWalletModal: TransferWallet | false;
}
export declare const routerSlice: import('@reduxjs/toolkit').Slice<RouterState, {
    setRoute: (state: RouterState, { payload }: PayloadAction<Route>) => void;
}, "router", "router", import('@reduxjs/toolkit').SliceSelectors<RouterState>>;
export declare const setRoute: import('@reduxjs/toolkit').ActionCreatorWithPayload<Route, "router/setRoute">;
declare const _default: import('@reduxjs/toolkit').Reducer<RouterState>;
export default _default;
//# sourceMappingURL=router.d.ts.map