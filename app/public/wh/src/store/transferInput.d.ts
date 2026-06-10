import { PayloadAction } from '@reduxjs/toolkit';
import { TokenTuple } from '../config/tokens';
import { TransferWallet } from '../utils/wallet';
import { WalletData } from './wallet';
import { DataWrapper } from './helpers';
import { Chain, amount } from '@wormhole-foundation/sdk';
export type ValidationErr = string;
export type TransferValidations = {
    sendingWallet: ValidationErr;
    receivingWallet: ValidationErr;
    fromChain: ValidationErr;
    toChain: ValidationErr;
    amount: ValidationErr;
    toNativeToken: ValidationErr;
    relayerFee: ValidationErr;
    receiveAmount: ValidationErr;
};
export interface TransferInputState {
    showValidationState: boolean;
    validations: TransferValidations;
    fromChain: Chain | undefined;
    toChain: Chain | undefined;
    token: TokenTuple | undefined;
    destToken: TokenTuple | undefined;
    amount?: amount.Amount;
    receiveAmount: DataWrapper<string>;
    route?: string;
    preferredRouteName?: string | undefined;
    foreignAsset: string;
    associatedTokenAddress: string;
    gasEst: {
        send: string;
        claim: string;
    };
    isTransactionInProgress: boolean;
    receiverNativeBalance: string | undefined;
}
export declare const transferInputSlice: import('@reduxjs/toolkit').Slice<TransferInputState, {
    setValidations: (state: TransferInputState, { payload: { showValidationState, validations }, }: PayloadAction<{
        showValidationState: boolean;
        validations: TransferValidations;
    }>) => void;
    setToken: (state: TransferInputState, { payload }: PayloadAction<TokenTuple>) => void;
    clearToken: (state: TransferInputState) => void;
    setDestToken: (state: TransferInputState, { payload }: PayloadAction<TokenTuple>) => void;
    clearDestToken: (state: TransferInputState) => void;
    setFromChain: (state: TransferInputState, { payload }: PayloadAction<Chain>) => void;
    setToChain: (state: TransferInputState, { payload }: PayloadAction<Chain>) => void;
    setAmount: (state: TransferInputState, { payload }: PayloadAction<string>) => void;
    setReceiveAmount: (state: TransferInputState, { payload }: PayloadAction<string>) => void;
    setFetchingReceiveAmount: (state: TransferInputState) => void;
    setReceiveAmountError: (state: TransferInputState, { payload }: PayloadAction<string>) => void;
    setTransferRoute: (state: TransferInputState, { payload }: PayloadAction<string | undefined>) => void;
    clearTransfer: (state: TransferInputState) => void;
    setIsTransactionInProgress: (state: TransferInputState, { payload }: PayloadAction<boolean>) => void;
    swapInputs: (state: TransferInputState) => void;
}, "transfer", "transfer", import('@reduxjs/toolkit').SliceSelectors<TransferInputState>>;
export declare const isDisabledChain: (chain: Chain, wallet: WalletData) => boolean;
export declare const selectFromChain: (dispatch: any, chain: Chain, wallet: WalletData) => Promise<void>;
export declare const selectToChain: (dispatch: any, chain: Chain, wallet: WalletData) => Promise<void>;
export declare const selectChain: (type: TransferWallet, dispatch: any, chain: Chain, wallet: WalletData) => Promise<void>;
export declare const setValidations: import('@reduxjs/toolkit').ActionCreatorWithPayload<{
    showValidationState: boolean;
    validations: TransferValidations;
}, "transfer/setValidations">, setToken: import('@reduxjs/toolkit').ActionCreatorWithPayload<TokenTuple, "transfer/setToken">, clearToken: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"transfer/clearToken">, setDestToken: import('@reduxjs/toolkit').ActionCreatorWithPayload<TokenTuple, "transfer/setDestToken">, clearDestToken: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"transfer/clearDestToken">, setFromChain: import('@reduxjs/toolkit').ActionCreatorWithPayload<"Solana" | "Ethereum" | "Bsc" | "Polygon" | "Avalanche" | "Algorand" | "Fantom" | "Klaytn" | "Celo" | "Near" | "Moonbeam" | "Injective" | "Osmosis" | "Sui" | "Aptos" | "Arbitrum" | "Optimism" | "Pythnet" | "Btc" | "Base" | "Sei" | "Scroll" | "Mantle" | "Xlayer" | "Linea" | "Berachain" | "Seievm" | "Unichain" | "Worldchain" | "Ink" | "HyperEVM" | "Monad" | "Mezo" | "Fogo" | "Sonic" | "Converge" | "Plume" | "XRPLEVM" | "Plasma" | "CreditCoin" | "Stacks" | "Moca" | "MegaETH" | "ZeroGravity" | "Wormchain" | "Cosmoshub" | "Evmos" | "Kujira" | "Neutron" | "Celestia" | "Stargaze" | "Seda" | "Dymension" | "Provenance" | "Noble" | "Sepolia" | "ArbitrumSepolia" | "BaseSepolia" | "OptimismSepolia" | "Holesky" | "PolygonSepolia" | "MonadTestnet" | "HyperCore", "transfer/setFromChain">, setToChain: import('@reduxjs/toolkit').ActionCreatorWithPayload<"Solana" | "Ethereum" | "Bsc" | "Polygon" | "Avalanche" | "Algorand" | "Fantom" | "Klaytn" | "Celo" | "Near" | "Moonbeam" | "Injective" | "Osmosis" | "Sui" | "Aptos" | "Arbitrum" | "Optimism" | "Pythnet" | "Btc" | "Base" | "Sei" | "Scroll" | "Mantle" | "Xlayer" | "Linea" | "Berachain" | "Seievm" | "Unichain" | "Worldchain" | "Ink" | "HyperEVM" | "Monad" | "Mezo" | "Fogo" | "Sonic" | "Converge" | "Plume" | "XRPLEVM" | "Plasma" | "CreditCoin" | "Stacks" | "Moca" | "MegaETH" | "ZeroGravity" | "Wormchain" | "Cosmoshub" | "Evmos" | "Kujira" | "Neutron" | "Celestia" | "Stargaze" | "Seda" | "Dymension" | "Provenance" | "Noble" | "Sepolia" | "ArbitrumSepolia" | "BaseSepolia" | "OptimismSepolia" | "Holesky" | "PolygonSepolia" | "MonadTestnet" | "HyperCore", "transfer/setToChain">, setAmount: import('@reduxjs/toolkit').ActionCreatorWithPayload<string, "transfer/setAmount">, setTransferRoute: import('@reduxjs/toolkit').ActionCreatorWithOptionalPayload<string | undefined, "transfer/setTransferRoute">, clearTransfer: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"transfer/clearTransfer">, setIsTransactionInProgress: import('@reduxjs/toolkit').ActionCreatorWithPayload<boolean, "transfer/setIsTransactionInProgress">, swapInputs: import('@reduxjs/toolkit').ActionCreatorWithoutPayload<"transfer/swapInputs">;
declare const _default: import('@reduxjs/toolkit').Reducer<TransferInputState>;
export default _default;
//# sourceMappingURL=transferInput.d.ts.map