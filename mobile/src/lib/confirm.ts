import { Alert, Platform } from 'react-native';

// Alert buttons don't work on web, so fall back to window.confirm there.
export function confirm(title: string, message: string, confirmLabel: string, onConfirm: () => void, cancelLabel = 'Cancel') {
  if (Platform.OS === 'web') {
    if (globalThis.confirm?.(`${title}\n\n${message}`)) onConfirm();
    return;
  }
  Alert.alert(title, message, [
    { text: cancelLabel, style: 'cancel' },
    { text: confirmLabel, style: 'destructive', onPress: onConfirm },
  ]);
}
