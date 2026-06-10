export declare const store: import('@reduxjs/toolkit').EnhancedStore<{
    redeem: import('./redeem').RedeemState;
    transferInput: import('./transferInput').TransferInputState;
    router: import('./router').RouterState;
    wallet: import('./wallet').WalletState;
    relay: import('./relay').RelayState;
    search: {
        txHash?: string;
        chain?: import('@wormhole-foundation/sdk-connect').Chain;
    };
}, import('@reduxjs/toolkit').UnknownAction, import('@reduxjs/toolkit').Tuple<[import('@reduxjs/toolkit').StoreEnhancer<{
    dispatch: import('redux-thunk').ThunkDispatch<{
        redeem: import('./redeem').RedeemState;
        transferInput: import('./transferInput').TransferInputState;
        router: import('./router').RouterState;
        wallet: import('./wallet').WalletState;
        relay: import('./relay').RelayState;
        search: {
            txHash?: string;
            chain?: import('@wormhole-foundation/sdk-connect').Chain;
        };
    }, undefined, import('@reduxjs/toolkit').UnknownAction>;
}>, import('@reduxjs/toolkit').StoreEnhancer]>>;
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
//# sourceMappingURL=index.d.ts.map