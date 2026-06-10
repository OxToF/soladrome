import { TransferError, TransferDetails } from '../telemetry/types';
export declare const INSUFFICIENT_ALLOWANCE_REGEX: RegExp;
export declare const INSUFFICIENT_LAMPORTS_REGEX: RegExp;
export declare const SIMULATION_ACCOUNT_NOT_FOUND_REGEX: RegExp;
export declare const USER_REJECTED_REGEX: RegExp;
export declare const AMOUNT_IN_TOO_SMALL: RegExp;
export declare const JUPITER_SLIPPAGE_ERROR: RegExp;
export declare const INSUFFICIENT_FUNDS_FOR_GAS_REGEX: RegExp;
export declare const INSUFFICIENT_FUNDS_REGEX: RegExp;
export declare function interpretTransferError(e: any, transferDetails: TransferDetails, context: 'send' | 'redeem'): [string, TransferError];
export declare function maybeLogSdkError(e: any, prefix?: string): void;
//# sourceMappingURL=errors.d.ts.map