import { default as React } from 'react';
import { TransferWallet } from '../../../../utils/wallet';
interface WalletPickerBottomSheetProps {
    open: boolean;
    onCancel: () => void;
    onOpen: () => void;
    onSelect: () => void;
    showAddressInput: boolean;
    title: React.ReactNode;
    walletType: TransferWallet;
}
declare function WalletPickerBottomSheet({ open, onCancel, onOpen, onSelect, showAddressInput, title, walletType, }: WalletPickerBottomSheetProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof WalletPickerBottomSheet>;
export default _default;
//# sourceMappingURL=WalletPickerBottomSheet.d.ts.map