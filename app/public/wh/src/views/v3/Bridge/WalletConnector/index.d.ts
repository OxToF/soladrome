import { default as React } from 'react';
import { TransferWallet } from '../../../../utils/wallet';
import { TransferSide } from '../../../../config/types';
type Props = {
    side: TransferSide;
    type: TransferWallet;
    disabled?: boolean;
};
declare const WalletConnector: (props: Props) => React.JSX.Element | null;
export default WalletConnector;
//# sourceMappingURL=index.d.ts.map