import { useSyncExternalStore } from 'react';
import { themeManager } from './ThemeManager.js';

export function useTheme() {
  return useSyncExternalStore(themeManager.subscribe, () => themeManager.getTheme());
}
