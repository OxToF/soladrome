import { default as React } from 'react';
import { TransferWallet } from '../../../../utils/wallet';
interface WalletPickerProps {
    isAddressInputVisible: boolean;
    open: boolean;
    setIsOpen: (open: boolean) => void;
    walletType: TransferWallet;
}
declare function WalletPicker({ isAddressInputVisible, open, setIsOpen, walletType, }: WalletPickerProps): React.JSX.Element | null;
declare const _default: React.MemoExoticComponent<typeof WalletPicker>;
export default _default;
//# sourceMappingURL=WalletPicker.d.ts.map