import { default as React } from 'react';
type Props = {
    placeholder?: string;
    value?: string;
    onChange: (e?: React.ChangeEvent<HTMLInputElement> | React.ChangeEvent<HTMLTextAreaElement>) => void;
    onSearch?: () => void;
};
declare function Search(props: Props): React.JSX.Element;
export default Search;
//# sourceMappingURL=Search.d.ts.map