import { default as React } from 'react';
import { ButtonProps as MUIButtonProps, SxProps, Theme } from '@mui/material';
type ButtonVariant = 'primary' | 'error' | 'default';
interface CustomButtonProps extends Omit<MUIButtonProps, 'variant' | 'sx'> {
    readonly variant?: ButtonVariant;
    readonly styleOverrides?: SxProps<Theme>;
}
/**
 * Custom Button component that extends MUI Button with predefined variants
 *
 * @param variant - The style variant of the button:
 *   - 'primary': Main CTA button with primary colors
 *   - 'error': Error state button with error colors
 *   - 'default': Standard MUI button (fallback)
 * @param styleOverrides - Additional style overrides
 * @param rest - All other MUI Button props
 *
 * @returns A styled button component
 */
declare const Button: ({ variant, styleOverrides, ...rest }: CustomButtonProps) => React.JSX.Element;
export default Button;
//# sourceMappingURL=Button.d.ts.map