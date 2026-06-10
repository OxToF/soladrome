import { amount as sdkAmount } from '@wormhole-foundation/sdk';
import { QuoteResult } from '../routes/operator';
export type AmountValidationResult = {
    error?: string;
    warning?: string;
    info?: string;
};
type Props = {
    balance?: sdkAmount.Amount | null;
    routes: string[];
    quotes: Record<string, QuoteResult | undefined>;
    failedQuotes: Record<string, QuoteResult | undefined>;
    tokenSymbol: string;
    isLoading: boolean;
    disabled?: boolean;
};
export declare const useAmountValidation: (props: Props) => AmountValidationResult;
export {};
//# sourceMappingURL=useAmountValidation.d.ts.map