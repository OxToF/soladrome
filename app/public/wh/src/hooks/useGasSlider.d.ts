import { Chain } from '@wormhole-foundation/sdk';
import { Token } from '../config/tokens';
type Props = {
    destChain?: Chain;
    destToken?: Token;
    route?: string;
    isTransactionInProgress: boolean;
};
export declare const useGasSlider: (props: Props) => {
    disabled: boolean;
    showGasSlider: boolean | undefined;
};
export {};
//# sourceMappingURL=useGasSlider.d.ts.map