import { default as React } from 'react';
import { TransferWallet } from '../../../../utils/wallet';
interface WalletPickerModalProps {
    open: boolean;
    onCancel: () => void;
    onSelect: () => void;
    showAddressInput: boolean;
    title: React.ReactNode;
    walletType: TransferWallet;
}
declare function WalletPickerModal({ open, onCancel, onSelect, showAddressInput, title, walletType, }: WalletPickerModalProps): React.JSX.Element;
export default WalletPickerModal;
//# sourceMappingURL=WalletPickerModal.d.ts.map