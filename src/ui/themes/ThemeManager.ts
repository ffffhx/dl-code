import type { Theme } from './types.js';
import { themePresets, defaultTheme } from './presets.js';

class ThemeManager {
  private currentTheme: Theme = defaultTheme;
  private themes: Map<string, Theme> = new Map();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  constructor() {
    Object.entries(themePresets).forEach(([name, theme]) => {
      this.themes.set(name, theme);
    });
  }

  getTheme(): Theme {
    return this.currentTheme;
  }

  setTheme(name: string): boolean {
    const theme = this.themes.get(name);
    if (theme) {
      this.currentTheme = theme;
      this.listeners.forEach(listener => listener());
      return true;
    }
    return false;
  }

  hasTheme(name: string): boolean {
    return this.themes.has(name);
  }

  listThemes(): string[] {
    return Array.from(this.themes.keys());
  }

  registerTheme(theme: Theme): void {
    this.themes.set(theme.name, theme);
  }

  getCurrentThemeName(): string {
    return this.currentTheme.name;
  }
}

export const themeManager = new ThemeManager();
