import { Dispatch } from 'react';
import { AnyAction } from '@reduxjs/toolkit';
import { TransferInputState, ValidationErr, TransferValidations } from '../store/transferInput';
import { WalletData, WalletState } from '../store/wallet';
import { RelayState } from '../store/relay';
import { Chain, amount as sdkAmount } from '@wormhole-foundation/sdk';
export declare const validateFromChain: (chain: Chain | undefined) => ValidationErr;
export declare const validateToChain: (chain: Chain | undefined, fromChain: Chain | undefined) => ValidationErr;
export declare const validateAmount: (amount: sdkAmount.Amount | undefined, balance: sdkAmount.Amount | null) => ValidationErr;
export declare const checkAddressIsSanctioned: (address: string) => boolean;
export declare const validateWallet: (wallet: WalletData, chain: Chain | undefined) => Promise<ValidationErr>;
export declare const validateToNativeAmt: (amount: number, max: number | undefined) => ValidationErr;
export declare const getIsAutomatic: (route?: string) => boolean;
export declare const validateAll: (transferData: TransferInputState, relayData: RelayState, walletData: WalletState) => Promise<TransferValidations>;
export declare const isTransferValid: (validations: TransferValidations) => boolean;
export declare const validate: ({ transferInput, relay, wallet, }: {
    transferInput: TransferInputState;
    relay: RelayState;
    wallet: WalletState;
}, dispatch: Dispatch<AnyAction>, isCanceled: () => boolean) => Promise<void>;
export declare const useValidate: () => void;
export declare const minutesAndSecondsWithPadding: (minutes: number, seconds: number) => string;
export declare const millisToMinutesAndSeconds: (millis: number) => string;
//# sourceMappingURL=transferValidation.d.ts.map