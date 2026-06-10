import { default as React } from 'react';
type Props = {
    placeholder?: string;
    type?: 'string' | 'number';
    align?: 'center' | 'right';
    id?: string;
    min?: number;
    max?: number;
    step?: number;
    inputRef?: React.MutableRefObject<null>;
    onChange?: (e?: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>) => void;
    onEnter?: React.KeyboardEventHandler;
    disabled?: boolean;
    value?: string | number;
    testId?: string;
};
declare function InputTransparent(props: Props): React.JSX.Element;
export default InputTransparent;
//# sourceMappingURL=InputTransparent.d.ts.map