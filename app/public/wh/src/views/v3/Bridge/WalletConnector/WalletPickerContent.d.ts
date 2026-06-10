import { default as React } from 'react';
import { TransferWallet } from '../../../../utils/wallet';
interface WalletPickerContentProps {
    onSelect: () => void;
    showAddressInput: boolean;
    walletType: TransferWallet;
}
declare function WalletPickerContent({ onSelect, showAddressInput, walletType, }: WalletPickerContentProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof WalletPickerContent>;
export default _default;
//# sourceMappingURL=WalletPickerContent.d.ts.map