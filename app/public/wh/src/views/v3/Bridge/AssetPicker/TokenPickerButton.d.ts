import { ChainConfig } from '../../../../config/types';
import { Token } from '../../../../config/tokens';
import { default as React } from 'react';
import { bindTrigger } from 'material-ui-popup-state/hooks';
interface TokenPickerButtonProps {
    chainConfig: ChainConfig | undefined;
    dataTestId?: string;
    isSource: boolean;
    isTransactionInProgress: boolean;
    openDrawer: () => void;
    token: Token | undefined;
    triggerProps: ReturnType<typeof bindTrigger>;
}
declare function TokenPickerButton({ chainConfig, dataTestId, isSource, isTransactionInProgress, openDrawer, token, triggerProps, }: TokenPickerButtonProps): React.JSX.Element;
declare const _default: React.MemoExoticComponent<typeof TokenPickerButton>;
export default _default;
//# sourceMappingURL=TokenPickerButton.d.ts.map