import { QuoteResult } from '../routes/operator';
type Props = {
    quotes: Record<string, QuoteResult | undefined>;
};
type ReturnProps = {
    error: string | undefined;
    errorInternal: any | undefined;
    info: string | undefined;
    onConfirm: () => void;
};
declare const useConfirmTransaction: (props: Props) => ReturnProps;
export default useConfirmTransaction;
//# sourceMappingURL=useConfirmTransaction.d.ts.map